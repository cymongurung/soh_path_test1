/**
 * Retail Store Stock Scanner Engine
 * Designed for IndexedDB storage, auto CSV header detection, camera zoom, & VPN lookups.
 */

// Global Application State
const CONFIG = {
    DB_NAME: 'RetailStockDB',
    DB_VERSION: 1,
    PRODUCTS_STORE: 'products',
    METADATA_STORE: 'metadata'
};

let db = null;
let html5QrcodeScanner = null;
let activeProduct = null;
let pendingImportData = null;

// Required CSV fields (used for automatic header row detection and data validation)
const REQUIRED_FIELDS = [
    'Product ID',
    'Barcode',
    'VPN',
    'Retail Selling Price Local',
    'Daily closing SOH quantity'
];

// Alternate header mapping dictionary for maximum CSV flexibility
const HEADER_ALIASES = {
    'product id': 'Product ID',
    'productid': 'Product ID',
    'barcode': 'Barcode',
    'vpn': 'VPN',
    'retail selling price local': 'Retail Selling Price Local',
    'retail price': 'Retail Selling Price Local',
    'daily closing soh quantity': 'Daily closing SOH quantity',
    'closing soh': 'Daily closing SOH quantity',
    'soh': 'Daily closing SOH quantity',
    'stock date': 'Stock Date',
    'brand': 'Brand',
    'department ': 'Department',
    'department': 'Department',
    'product description w/o vpn': 'Product Description w/o vpn',
    'description': 'Product Description w/o vpn',
    'daily closing soh local retail value': 'Daily closing SOH Local Retail Value'
};

// ==========================================
// 1. INITIALIZATION & DATABASE ENGINE
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    await initIndexedDB();
    await checkAutoLoadDefaultCSV();
    await refreshDataStatus();
    initScannerUI();
});

/**
 * Initializes IndexedDB storage for offline, high-volume inventory storage.
 */
function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

        request.onupgradeneeded = (e) => {
            const dbRef = e.target.result;

            if (!dbRef.objectStoreNames.contains(CONFIG.PRODUCTS_STORE)) {
                const prodStore = dbRef.createObjectStore(CONFIG.PRODUCTS_STORE, { keyPath: 'id', autoIncrement: true });
                // Create indexes for high-speed queries
                prodStore.createIndex('clean_barcode', 'clean_barcode', { unique: false });
                prodStore.createIndex('clean_pid', 'clean_pid', { unique: false });
                prodStore.createIndex('vpn', 'vpn', { unique: false });
            }

            if (!dbRef.objectStoreNames.contains(CONFIG.METADATA_STORE)) {
                dbRef.createObjectStore(CONFIG.METADATA_STORE, { keyPath: 'key' });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };

        request.onerror = (e) => {
            showToast('Failed to open database.');
            reject(e);
        };
    });
}

/**
 * Checks for a default CSV file at data/current.csv on first load if DB is empty.
 */
async function checkAutoLoadDefaultCSV() {
    const meta = await getMetadata('current_file');
    if (meta) return; // Inventory already loaded

    try {
        const response = await fetch('data/current.csv');
        if (response.ok) {
            const csvText = await response.text();
            showToast('Loading initial dataset...');
            const parsed = parseCSVContent(csvText, 'data/current.csv');
            if (parsed.valid) {
                await commitInventoryToDB(parsed);
                showToast('Initial inventory auto-loaded!');
            }
        }
    } catch (e) {
        // Default data file optional; silent fallthrough to empty state
    }
}

// ==========================================
// 2. CSV PARSER & HEADER DETECTOR
// ==========================================

/**
 * Sanitizes numeric search keys by stripping non-alphanumeric characters and leading zeros.
 */
function cleanSearchKey(val) {
    if (!val) return '';
    const str = String(val).trim();
    // Keep numbers and letters, remove leading zeros for robust matching
    const stripped = str.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
}

/**
 * Parses raw CSV content, auto-detects header row, and maps column fields.
 */
function parseCSVContent(csvText, fileName) {
    const lines = Papa.parse(csvText, { skipEmptyLines: true }).data;
    if (!lines || lines.length === 0) {
        return { valid: false, error: 'The file is completely empty.' };
    }

    // Step 1: Detect actual header row (look within first 15 rows)
    let headerRowIndex = -1;
    let headerMap = {};

    for (let r = 0; r < Math.min(lines.length, 15); r++) {
        const row = lines[r];
        const tempMap = {};
        
        row.forEach((colStr, colIdx) => {
            if (!colStr) return;
            const normalized = String(colStr).trim().toLowerCase();
            const matchedKey = HEADER_ALIASES[normalized] || colStr.trim();
            tempMap[matchedKey] = colIdx;
        });

        // Check if all required fields are present in this row
        const hasAllRequired = REQUIRED_FIELDS.every(field => tempMap.hasOwnProperty(field));
        if (hasAllRequired) {
            headerRowIndex = r;
            headerMap = tempMap;
            break;
        }
    }

    if (headerRowIndex === -1) {
        return {
            valid: false,
            error: `Could not auto-detect header row. Missing required columns: ${REQUIRED_FIELDS.join(', ')}`
        };
    }

    // Step 2: Parse product data rows
    const products = [];
    let stockDate = 'Unknown';
    let totalSoh = 0;
    let totalValue = 0;

    for (let i = headerRowIndex + 1; i < lines.length; i++) {
        const row = lines[i];
        if (!row || row.length <= 1) continue;

        const rawPid = row[headerMap['Product ID']] || '';
        const rawBarcode = row[headerMap['Barcode']] || '';
        const rawVpn = row[headerMap['VPN']] || '';
        const rawPrice = row[headerMap['Retail Selling Price Local']] || '0';
        const rawSoh = row[headerMap['Daily closing SOH quantity']] || '0';

        if (!rawPid && !rawBarcode) continue; // Skip invalid rows

        const desc = row[headerMap['Product Description w/o vpn']] || 'No Description';
        const brand = row[headerMap['Brand']] || '';
        const dept = row[headerMap['Department']] || '';
        const rowDate = row[headerMap['Stock Date']] || '';
        const rawRetailVal = row[headerMap['Daily closing SOH Local Retail Value']] || '0';

        if (rowDate && stockDate === 'Unknown') {
            stockDate = String(rowDate).trim();
        }

        const sohNum = parseInt(String(rawSoh).replace(/,/g, ''), 10) || 0;
        const retailValNum = parseFloat(String(rawRetailVal).replace(/,/g, '')) || 0;

        totalSoh += sohNum;
        totalValue += retailValNum;

        products.push({
            pid: String(rawPid).trim(),
            barcode: String(rawBarcode).trim(),
            clean_pid: cleanSearchKey(rawPid),
            clean_barcode: cleanSearchKey(rawBarcode),
            desc: String(desc).trim(),
            brand: String(brand).trim(),
            dept: String(dept).trim(),
            price: String(rawPrice).trim(),
            soh: sohNum,
            vpn: String(rawVpn).trim()
        });
    }

    return {
        valid: true,
        fileName: fileName,
        stockDate: stockDate,
        rowsCount: products.length,
        totalSoh: totalSoh,
        totalValue: totalValue,
        products: products
    };
}

// ==========================================
// 3. INDEXEDDB DATA OPERATIONS
// ==========================================

function getMetadata(key) {
    return new Promise((resolve) => {
        if (!db) return resolve(null);
        const tx = db.transaction(CONFIG.METADATA_STORE, 'readonly');
        const store = tx.objectStore(CONFIG.METADATA_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
    });
}

function setMetadata(key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CONFIG.METADATA_STORE, 'readwrite');
        const store = tx.objectStore(CONFIG.METADATA_STORE);
        const req = store.put({ key: key, value: value });
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e);
    });
}

/**
 * Clears old data and writes new parsed inventory to IndexedDB.
 */
async function commitInventoryToDB(parsedData) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([CONFIG.PRODUCTS_STORE, CONFIG.METADATA_STORE], 'readwrite');
        const prodStore = tx.objectStore(CONFIG.PRODUCTS_STORE);
        const metaStore = tx.objectStore(CONFIG.METADATA_STORE);

        // Clear existing product data
        prodStore.clear();

        // Write new products in bulk
        parsedData.products.forEach(p => prodStore.add(p));

        // Save metadata attributes
        metaStore.put({ key: 'stock_date', value: parsedData.stockDate });
        metaStore.put({ key: 'rows_count', value: parsedData.rowsCount });
        metaStore.put({ key: 'total_soh', value: parsedData.totalSoh });
        metaStore.put({ key: 'total_value', value: parsedData.totalValue });
        metaStore.put({ key: 'current_file', value: parsedData.fileName });
        metaStore.put({ key: 'last_updated', value: new Date().toLocaleString() });

        tx.oncomplete = async () => {
            await refreshDataStatus();
            resolve();
        };

        tx.onerror = (e) => reject(e);
    });
}

/**
 * Searches product by Barcode or Product ID in IndexedDB.
 */
function searchProduct(query) {
    return new Promise((resolve) => {
        if (!db || !query) return resolve(null);
        const cleanQuery = cleanSearchKey(query);
        const tx = db.transaction(CONFIG.PRODUCTS_STORE, 'readonly');
        const store = tx.objectStore(CONFIG.PRODUCTS_STORE);

        // Search via Barcode index first
        const barcodeIndex = store.index('clean_barcode');
        const req1 = barcodeIndex.get(cleanQuery);

        req1.onsuccess = () => {
            if (req1.result) {
                resolve(req1.result);
            } else {
                // Search via Product ID index second
                const pidIndex = store.index('clean_pid');
                const req2 = pidIndex.get(cleanQuery);
                req2.onsuccess = () => resolve(req2.result || null);
                req2.onerror = () => resolve(null);
            }
        };
        req1.onerror = () => resolve(null);
    });
}

/**
 * Retrieves all items matching the provided VPN.
 */
function getRelatedByVPN(vpn) {
    return new Promise((resolve) => {
        if (!db || !vpn) return resolve([]);
        const tx = db.transaction(CONFIG.PRODUCTS_STORE, 'readonly');
        const store = tx.objectStore(CONFIG.PRODUCTS_STORE);
        const index = store.index('vpn');
        const req = index.getAll(vpn);

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

// ==========================================
// 4. CAMERA BARCODE SCANNER & ZOOM ENGINE
// ==========================================

function initScannerUI() {
    const btnStart = document.getElementById('btn-start-scanner');
    btnStart.addEventListener('click', startCameraScanner);
}

async function startCameraScanner() {
    const errorBox = document.getElementById('camera-error');
    const controls = document.getElementById('scanner-controls');
    errorBox.classList.add('hidden');

    if (!html5QrcodeScanner) {
        html5QrcodeScanner = new Html5Qrcode("reader");
    }

    const config = {
        fps: 15,
        qrbox: { width: 250, height: 150 },
        formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_128
        ]
    };

    try {
        await html5QrcodeScanner.start(
            { facingMode: { exact: "environment" } },
            config,
            onBarcodeScanned,
            onScanFailure
        );
        controls.classList.add('hidden');
        await applyOptimalCameraZoom();
    } catch (err) {
        // Fallback to any environment camera if exact facingMode fails
        try {
            await html5QrcodeScanner.start(
                { facingMode: "environment" },
                config,
                onBarcodeScanned,
                onScanFailure
            );
            controls.classList.add('hidden');
            await applyOptimalCameraZoom();
        } catch (err2) {
            errorBox.textContent = `Camera Permission Error: ${err2.message || err2}. Please ensure camera access is granted.`;
            errorBox.classList.remove('hidden');
            controls.classList.remove('hidden');
        }
    }
}

/**
 * Controls camera zoom (requests 2x zoom or highest supported zoom).
 */
async function applyOptimalCameraZoom() {
    const zoomBadge = document.getElementById('zoom-status-badge');
    try {
        const capabilities = html5QrcodeScanner.getRunningTrackCapabilities();
        if (capabilities && capabilities.zoom) {
            const min = capabilities.zoom.min || 1;
            const max = capabilities.zoom.max || 1;
            
            // Aim for 2x zoom, capped at maximum available
            let targetZoom = 2.0;
            if (targetZoom < min) targetZoom = min;
            if (targetZoom > max) targetZoom = max;

            await html5QrcodeScanner.applyVideoConstraints({
                advanced: [{ zoom: targetZoom }]
            });
            zoomBadge.textContent = `Zoom: ${targetZoom}×`;
        } else {
            zoomBadge.textContent = 'Zoom: N/A';
        }
    } catch (e) {
        zoomBadge.textContent = 'Zoom: Default';
    }
}

async function stopCameraScanner() {
    if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
        try {
            await html5QrcodeScanner.stop();
        } catch (e) {
            // Scanner stopped
        }
    }
    document.getElementById('scanner-controls').classList.remove('hidden');
}

function onBarcodeScanned(decodedText) {
    // Pause/stop scanner upon success
    stopCameraScanner();
    showToast(`Scanned: ${decodedText}`);
    executeSearch(decodedText);
}

function onScanFailure(error) {
    // Continuous background scanning loop (failures ignored)
}

// ==========================================
// 5. SEARCH & UI RENDERING WORKFLOW
// ==========================================

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('manual-search-input');

searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (query) {
        executeSearch(query);
    }
});

async function executeSearch(query) {
    const product = await searchProduct(query);
    const container = document.getElementById('product-result-container');
    const relatedContainer = document.getElementById('related-items-container');
    
    relatedContainer.classList.add('hidden');

    if (!product) {
        container.classList.add('hidden');
        showToast(`No product found matching "${query}"`);
        return;
    }

    activeProduct = product;
    
    // Display Product Info
    document.getElementById('res-description').textContent = product.desc;
    document.getElementById('res-price').textContent = `AED ${product.price}`;
    document.getElementById('res-soh').textContent = product.soh;
    document.getElementById('res-pid').textContent = product.pid;
    document.getElementById('res-barcode').textContent = product.barcode;
    document.getElementById('res-brand').textContent = product.brand || 'N/A';
    document.getElementById('res-dept').textContent = product.dept || 'N/A';
    document.getElementById('res-vpn').textContent = product.vpn;

    container.classList.remove('hidden');
    container.scrollIntoView({ behavior: 'smooth' });
}

// Button Events for Product Result Actions
document.getElementById('btn-show-related').addEventListener('click', async () => {
    if (!activeProduct || !activeProduct.vpn) return;

    const related = await getRelatedByVPN(activeProduct.vpn);
    const tbody = document.getElementById('related-items-tbody');
    document.getElementById('related-vpn-label').textContent = activeProduct.vpn;
    
    tbody.innerHTML = '';
    
    related.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.pid}</strong></td>
            <td>${item.barcode}</td>
            <td>${item.desc}</td>
            <td>AED ${item.price}</td>
            <td><strong>${item.soh}</strong></td>
        `;
        tbody.appendChild(tr);
    });

    const relatedContainer = document.getElementById('related-items-container');
    relatedContainer.classList.remove('hidden');
    relatedContainer.scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-next-scan').addEventListener('click', () => {
    document.getElementById('product-result-container').classList.add('hidden');
    document.getElementById('manual-search-input').value = '';
    startCameraScanner();
});

// ==========================================
// 6. CSV UPLOAD & REPLACEMENT WORKFLOW
// ==========================================

const fileInput = document.getElementById('csv-file-input');
const fileNameDisplay = document.getElementById('file-name-display');
const uploadErrorBox = document.getElementById('upload-error-box');
const confirmationCard = document.getElementById('confirmation-card');

fileInput.addEventListener('change', handleFileSelection);

function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    fileNameDisplay.textContent = file.name;
    uploadErrorBox.classList.add('hidden');

    const reader = new FileReader();
    reader.onload = async (event) => {
        const text = event.target.result;
        const parsed = parseCSVContent(text, file.name);

        if (!parsed.valid) {
            uploadErrorBox.textContent = parsed.error;
            uploadErrorBox.classList.remove('hidden');
            confirmationCard.classList.add('hidden');
            return;
        }

        pendingImportData = parsed;
        await prepareConfirmationScreen(parsed);
    };
    reader.readAsText(file);
}

async function prepareConfirmationScreen(newData) {
    const currDate = await getMetadata('stock_date') || 'None';
    const currRows = await getMetadata('rows_count') || '0';
    const currFile = await getMetadata('current_file') || 'None';

    document.getElementById('conf-curr-date').textContent = currDate;
    document.getElementById('conf-curr-rows').textContent = Number(currRows).toLocaleString();
    document.getElementById('conf-curr-file').textContent = currFile;

    document.getElementById('conf-new-date').textContent = newData.stockDate;
    document.getElementById('conf-new-rows').textContent = Number(newData.rowsCount).toLocaleString();
    document.getElementById('conf-new-file').textContent = newData.fileName;

    // Date warning check
    const dateWarn = document.getElementById('date-warning-box');
    if (currDate !== 'None' && newData.stockDate <= currDate) {
        dateWarn.classList.remove('hidden');
    } else {
        dateWarn.classList.add('hidden');
    }

    confirmationCard.classList.remove('hidden');
    confirmationCard.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('btn-cancel-upload').addEventListener('click', () => {
    pendingImportData = null;
    fileInput.value = '';
    fileNameDisplay.textContent = 'No file selected';
    confirmationCard.classList.add('hidden');
});

document.getElementById('btn-confirm-upload').addEventListener('click', async () => {
    if (!pendingImportData) return;

    showToast('Replacing inventory...');
    await commitInventoryToDB(pendingImportData);
    
    showToast('Inventory updated successfully!');
    pendingImportData = null;
    fileInput.value = '';
    fileNameDisplay.textContent = 'No file selected';
    confirmationCard.classList.add('hidden');

    // Switch view to Scanner
    switchView('view-scanner');
});

// ==========================================
// 7. DATA STATUS PAGE & METRICS
// ==========================================

async function refreshDataStatus() {
    const statusVal = document.getElementById('stat-status');
    const badge = document.getElementById('quick-status-badge');

    const stockDate = await getMetadata('stock_date');
    const rowsCount = await getMetadata('rows_count');
    const totalSoh = await getMetadata('total_soh');
    const totalVal = await getMetadata('total_value');
    const fileName = await getMetadata('current_file');
    const lastUpdated = await getMetadata('last_updated');

    if (stockDate) {
        statusVal.textContent = 'Current / Loaded';
        statusVal.style.color = 'var(--success)';
        badge.textContent = 'Active';
        badge.className = 'badge badge-success';

        document.getElementById('stat-date').textContent = stockDate;
        document.getElementById('stat-rows').textContent = Number(rowsCount).toLocaleString();
        document.getElementById('stat-soh').textContent = Number(totalSoh).toLocaleString();
        document.getElementById('stat-value').textContent = `AED ${Number(totalVal).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        document.getElementById('stat-filename').textContent = fileName;
        document.getElementById('stat-updated').textContent = lastUpdated;
    } else {
        statusVal.textContent = 'Not Loaded';
        statusVal.style.color = 'var(--danger)';
        badge.textContent = 'No Data';
        badge.className = 'badge badge-warning';

        document.getElementById('stat-date').textContent = '--';
        document.getElementById('stat-rows').textContent = '0';
        document.getElementById('stat-soh').textContent = '0';
        document.getElementById('stat-value').textContent = 'AED 0.00';
        document.getElementById('stat-filename').textContent = 'None';
        document.getElementById('stat-updated').textContent = 'Never';
    }
}

// ==========================================
// 8. NAVIGATION & SIDEBAR UI
// ==========================================

function initNavigation() {
    const menuToggle = document.getElementById('menu-toggle');
    const menuClose = document.getElementById('menu-close');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const navLinks = document.querySelectorAll('.nav-link');

    const toggleSidebar = () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
    };

    menuToggle.addEventListener('click', toggleSidebar);
    menuClose.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', toggleSidebar);

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const targetView = link.getAttribute('data-target');
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            switchView(targetView);
            toggleSidebar();
        });
    });
}

function switchView(viewId) {
    document.querySelectorAll('.view-page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(viewId).classList.add('active');
    
    // Stop camera when moving away from scanner tab
    if (viewId !== 'view-scanner') {
        stopCameraScanner();
    }
}

// Toast Notification System
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}