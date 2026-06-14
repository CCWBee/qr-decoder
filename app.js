// DOM Elements
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const cameraBtn = document.getElementById('cameraBtn');
const progressSection = document.getElementById('progressSection');
const sessionIdSpan = document.getElementById('sessionId');
const progressText = document.getElementById('progressText');
const compressionInfo = document.getElementById('compressionInfo');
const chunkGrid = document.getElementById('chunkGrid');
const resultSection = document.getElementById('resultSection');
const resultText = document.getElementById('resultText');
const resultStats = document.getElementById('resultStats');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const installPrompt = document.getElementById('installPrompt');
const installBtn = document.getElementById('installBtn');
const dismissBtn = document.getElementById('dismissBtn');

// State
let stream = null;
let scanning = false;
let currentSession = null;
let receivedChunks = new Map();
let totalChunks = 0;
let isCompressed = false;
let animationId = null;
let pendingFile = null; // set when the received payload is a wrapped file

// Initialize
function init() {
    cameraBtn.addEventListener('click', toggleCamera);
    copyBtn.addEventListener('click', copyResult);
    saveBtn.addEventListener('click', saveResult);
    resetBtn.addEventListener('click', reset);

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.log('SW registration failed:', err));
    }
}

// Camera handling
async function toggleCamera() {
    if (stream) {
        stopCamera();
    } else {
        await startCamera();
    }
}

async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 1280 }
            }
        });
        video.srcObject = stream;
        await video.play();

        cameraBtn.textContent = 'Stop Camera';
        cameraBtn.classList.add('active');

        // Set canvas size
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        scanning = true;
        scan();

        hideError();
    } catch (err) {
        showError('Camera access denied. Please allow camera permissions.');
        console.error('Camera error:', err);
    }
}

function stopCamera() {
    scanning = false;
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    video.srcObject = null;
    cameraBtn.textContent = 'Start Camera';
    cameraBtn.classList.remove('active');
}

// QR Scanning
function scan() {
    if (!scanning) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
        });

        if (code) {
            processQRCode(code.data);
        }
    }

    animationId = requestAnimationFrame(scan);
}

function processQRCode(data) {
    try {
        const payload = JSON.parse(data);

        // Validate payload structure
        if (!payload.v || !payload.id || payload.i === undefined || !payload.t || !payload.d) {
            return; // Invalid payload, skip
        }

        // Check protocol version
        if (payload.v !== 1) {
            showError(`Unsupported protocol version: ${payload.v}`);
            return;
        }

        // New session?
        if (currentSession !== payload.id) {
            startNewSession(payload.id, payload.t, payload.c || false);
        }

        // Store chunk if not already received
        if (!receivedChunks.has(payload.i)) {
            receivedChunks.set(payload.i, payload.d);
            updateProgress(payload.i);

            // Check if complete
            if (receivedChunks.size === totalChunks) {
                completeTransfer();
            }
        }
    } catch (err) {
        // Not a valid JSON QR code, ignore
    }
}

function startNewSession(id, total, compressed) {
    currentSession = id;
    totalChunks = total;
    isCompressed = compressed;
    receivedChunks.clear();

    // Update UI
    sessionIdSpan.textContent = id;
    progressText.textContent = `0/${total}`;

    if (compressed) {
        compressionInfo.classList.remove('hidden');
    } else {
        compressionInfo.classList.add('hidden');
    }

    // Build chunk grid
    chunkGrid.innerHTML = '';
    for (let i = 0; i < total; i++) {
        const chunk = document.createElement('div');
        chunk.className = 'chunk';
        chunk.id = `chunk-${i}`;
        chunk.textContent = i + 1;
        chunkGrid.appendChild(chunk);
    }

    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
}

function updateProgress(index) {
    const chunk = document.getElementById(`chunk-${index}`);
    if (chunk) {
        chunk.classList.add('received');
    }
    progressText.textContent = `${receivedChunks.size}/${totalChunks}`;
}

function completeTransfer() {
    stopCamera();

    try {
        // Reassemble chunks in order
        let base64Data = '';
        for (let i = 0; i < totalChunks; i++) {
            base64Data += receivedChunks.get(i);
        }

        // Decode base64 to bytes
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Decompress if needed
        let finalBytes = bytes;
        if (isCompressed) {
            try {
                finalBytes = pako.inflate(bytes);
            } catch (err) {
                showError('Decompression failed: ' + err.message);
                return;
            }
        }

        // File transfer? ('QRF1' magic + 2-byte header len + JSON{n,m} header + file bytes)
        if (finalBytes.length > 6 &&
            finalBytes[0] === 0x51 && finalBytes[1] === 0x52 &&
            finalBytes[2] === 0x46 && finalBytes[3] === 0x31) {
            const hdrLen = (finalBytes[4] << 8) | finalBytes[5];
            const meta = JSON.parse(new TextDecoder().decode(finalBytes.subarray(6, 6 + hdrLen)));
            const body = finalBytes.slice(6 + hdrLen);
            showFile(meta.n || 'file.bin', meta.m || 'application/octet-stream', body);
            return;
        }

        // Decode to text
        const decoder = new TextDecoder();
        const text = decoder.decode(finalBytes);

        // Display result
        resultText.textContent = text;
        resultStats.textContent = `${text.length} characters`;
        resultSection.classList.remove('hidden');

        // Keep progress visible
        progressSection.classList.remove('hidden');

    } catch (err) {
        showError('Failed to decode data: ' + err.message);
    }
}

// Received a file: show it at the bottom with a Save button (binary-safe)
function showFile(name, type, bytes) {
    pendingFile = { name, type, bytes };
    resultText.textContent = `📎 ${name}\n${bytes.length} bytes` + (type ? `\n${type}` : '');
    resultStats.textContent = `${bytes.length} bytes`;
    copyBtn.classList.add('hidden');   // copy is meaningless for binary
    saveBtn.textContent = 'Save File';
    resultSection.classList.remove('hidden');
    progressSection.classList.remove('hidden');
}

// Result handling
async function copyResult() {
    const text = resultText.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
            copyBtn.textContent = 'Copy All';
            copyBtn.classList.remove('copied');
        }, 2000);
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = 'Copy All';
                copyBtn.classList.remove('copied');
            }, 2000);
        } catch (e) {
            showError('Failed to copy to clipboard');
        }
        document.body.removeChild(textarea);
    }
}

function saveResult() {
    let blob, filename, btnLabel;
    if (pendingFile) {
        blob = new Blob([pendingFile.bytes], { type: pendingFile.type });
        filename = pendingFile.name;
        btnLabel = 'Save File';
    } else {
        blob = new Blob([resultText.textContent], { type: 'text/plain' });
        filename = `qr-scan-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
        btnLabel = 'Save .txt';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    saveBtn.textContent = 'Saved!';
    setTimeout(() => { saveBtn.textContent = btnLabel; }, 2000);
}

function reset() {
    currentSession = null;
    receivedChunks.clear();
    totalChunks = 0;
    isCompressed = false;
    pendingFile = null;

    progressSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    hideError();

    chunkGrid.innerHTML = '';
    resultText.textContent = '';
    copyBtn.classList.remove('hidden');
    saveBtn.textContent = 'Save .txt';
}

// Error handling
function showError(message) {
    errorMessage.textContent = message;
    errorSection.classList.remove('hidden');
}

function hideError() {
    errorSection.classList.add('hidden');
}

// PWA Install
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installPrompt.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('Install outcome:', outcome);
    deferredPrompt = null;
    installPrompt.classList.add('hidden');
});

dismissBtn.addEventListener('click', () => {
    installPrompt.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
    console.log('PWA installed');
    installPrompt.classList.add('hidden');
});

// Start
init();
