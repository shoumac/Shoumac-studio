const fileInput = document.getElementById("audioFile");
const processBtn = document.getElementById("processBtn");
const downloadBtn = document.getElementById("downloadBtn");
const player = document.getElementById("audioPlayer");

let sourceFile = null;
let originalUrl = null;
let processedUrl = null;

function formatBytes(bytes) {
    return bytes < 1048576
        ? Math.round(bytes / 1024) + " Ko"
        : (bytes / 1048576).toFixed(1) + " Mo";
}

function setFile(file) {
    if (!file || !file.type.startsWith("audio/")) {
        alert("Choisis un fichier audio valide.");
        return;
    }

    sourceFile = file;

    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (processedUrl) URL.revokeObjectURL(processedUrl);

    originalUrl = URL.createObjectURL(file);
    processedUrl = null;

    document.getElementById("fileMeta").classList.remove("hidden");
    document.getElementById("fileName").textContent = file.name;
    document.getElementById("fileSize").textContent =
        formatBytes(file.size) + " • fichier local";

    document.getElementById("resultTitle").textContent =
        file.name.replace(/\.[^.]+$/, "");

    document.getElementById("resultSubtitle").textContent =
        "Original prêt à écouter";

    document.getElementById("status").textContent = "FICHIER CHARGÉ";

    player.src = originalUrl;
    processBtn.disabled = false;
    downloadBtn.disabled = true;
}

fileInput.addEventListener("change", event => {
    setFile(event.target.files[0]);
});

document.getElementById("removeFile").addEventListener("click", () => {
    sourceFile = null;
    fileInput.value = "";

    document.getElementById("fileMeta").classList.add("hidden");

    player.removeAttribute("src");
    player.load();

    processBtn.disabled = true;
    downloadBtn.disabled = true;

    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (processedUrl) URL.revokeObjectURL(processedUrl);

    originalUrl = null;
    processedUrl = null;
});

document.getElementById("intensity").addEventListener("input", event => {
    document.getElementById("intensityValue").textContent =
        event.target.value + "/10";
});

document.querySelectorAll(".compare-tab").forEach(button => {
    button.addEventListener("click", () => {
        const type = button.dataset.source;

        if (type === "processed" && !processedUrl) {
            alert("Traite d'abord ton morceau.");
            return;
        }

        player.src = type === "processed" ? processedUrl : originalUrl;
        player.load();

        document.querySelectorAll(".compare-tab").forEach(tab => {
            tab.classList.toggle("active", tab === button);
        });

        document.getElementById("resultSubtitle").textContent =
            type === "processed" ? "Version traitée" : "Version originale";
    });
});

processBtn.addEventListener("click", async () => {
    if (!sourceFile) return;

    processBtn.disabled = true;
    processBtn.textContent = "⏳ Traitement en cours…";

    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
            throw new Error("Web Audio n'est pas pris en charge.");
        }

        const context = new AudioContextClass();

        const buffer = await context.decodeAudioData(
            await sourceFile.arrayBuffer()
        );

        const sampleRate = 44100;

        const offline = new OfflineAudioContext(
            2,
            Math.ceil(buffer.duration * sampleRate),
            sampleRate
        );

        const source = offline.createBufferSource();
        source.buffer = buffer;

        const intensity =
            Number(document.getElementById("intensity").value) / 10;

        const mode = document.getElementById("mode").value;

        const bass = offline.createBiquadFilter();
        bass.type = "lowshelf";
        bass.frequency.value = 110;
        bass.gain.value = (mode === "voice" ? -1.5 : 1.2) * intensity;

        const mud = offline.createBiquadFilter();
        mud.type = "peaking";
        mud.frequency.value = mode === "voice" ? 280 : 320;
        mud.Q.value = 0.9;
        mud.gain.value = -2 * intensity;

        const presence = offline.createBiquadFilter();
        presence.type = "peaking";
        presence.frequency.value = mode === "voice" ? 3200 : 2500;
        presence.Q.value = 0.8;
        presence.gain.value = (mode === "voice" ? 2 : 0.8) * intensity;

        const compressor = offline.createDynamicsCompressor();
        compressor.threshold.value = -20 - intensity * 5;
        compressor.knee.value = 15;
        compressor.ratio.value = 2.2 + intensity * 1.8;
        compressor.attack.value = 0.012;
        compressor.release.value = 0.22;

        const limiter = offline.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.12;

        source.connect(bass);
        bass.connect(mud);
        mud.connect(presence);
        presence.connect(compressor);
        compressor.connect(limiter);
        limiter.connect(offline.destination);

        source.start();

        const rendered = await offline.startRendering();

        processedUrl = URL.createObjectURL(
            new Blob([audioBufferToWav(rendered)], {
                type: "audio/wav"
            })
        );

        player.src = processedUrl;
        player.load();

        document.getElementById("status").textContent =
            "TRAITEMENT TERMINÉ";

        document.getElementById("status").classList.add("ready");

        document.getElementById("resultSubtitle").textContent =
            "Version traitée • écoute avant export";

        document.getElementById("resultNote").textContent =
            "Écoute attentivement le résultat. Le traitement automatique " +
            "peut nécessiter des ajustements selon ton morceau.";

        downloadBtn.disabled = false;

        processBtn.textContent = "↻ Refaire le traitement";
        processBtn.disabled = false;

        await context.close();

    } catch (error) {
        alert("Le traitement a échoué : " + error.message);

        processBtn.textContent = "⚡ Améliorer mon son";
        processBtn.disabled = false;
    }
});

downloadBtn.addEventListener("click", () => {
    if (!processedUrl || !sourceFile) return;

    const link = document.createElement("a");

    link.href = processedUrl;
    link.download =
        sourceFile.name.replace(/\.[^.]+$/, "") +
        "_SHOUMAC_MASTER.wav";

    link.click();
});

function audioBufferToWav(buffer) {
    const channels = Math.min(buffer.numberOfChannels, 2);
    const length = buffer.length;
    const sampleRate = buffer.sampleRate;

    const samples = new Float32Array(length * channels);

    for (let i = 0; i < length; i++) {
        for (let channel = 0; channel < channels; channel++) {
            samples[i * channels + channel] =
                buffer.getChannelData(channel)[i];
        }
    }

    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);

    function writeString(offset, text) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;

    for (const sample of samples) {
        const value = Math.max(-1, Math.min(1, sample));

        view.setInt16(
            offset,
            value < 0 ? value * 32768 : value * 32767,
            true
        );

        offset += 2;
    }

    return bytes;
}
