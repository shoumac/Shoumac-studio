"use strict";

/* =========================================================
   SHOUMAC STUDIO — AUDIO ENGINE
   Traitement naturel, adaptatif et local
   ========================================================= */

const $ = (id) => document.getElementById(id);

const fileInput = $("audioFile");
const processBtn = $("processBtn");
const downloadBtn = $("downloadBtn");
const player = $("audioPlayer");

let sourceFile = null;
let originalUrl = null;
let processedUrl = null;
let processedBlob = null;
let processing = false;

const DEFAULT_PROCESS_TEXT = "⚡ Améliorer mon son";

/* -------------------------
   UTILITAIRES
------------------------- */

function setStatus(message, ready = false) {
    $("status").textContent = message;
    $("status").classList.toggle("ready", ready);
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) {
        return Math.round(bytes / 1024) + " Ko";
    }

    return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
}

function revokeUrl(url) {
    if (url) URL.revokeObjectURL(url);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

function linearToDb(value) {
    return 20 * Math.log10(Math.max(value, 0.0000001));
}

function setActiveTab(type) {
    document.querySelectorAll(".compare-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.source === type);
    });
}

function resetProcessedAudio() {
    revokeUrl(processedUrl);

    processedUrl = null;
    processedBlob = null;

    downloadBtn.disabled = true;
}

/* -------------------------
   ANALYSE AUDIO
------------------------- */

function analyzeBuffer(buffer) {
    let sumSquares = 0;
    let peak = 0;
    let count = 0;

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);

        // Échantillonnage de l'analyse pour accélérer le calcul.
        const step = Math.max(1, Math.floor(data.length / 500000));

        for (let i = 0; i < data.length; i += step) {
            const value = data[i];
            const absolute = Math.abs(value);

            sumSquares += value * value;
            peak = Math.max(peak, absolute);
            count++;
        }
    }

    const rms = count ? Math.sqrt(sumSquares / count) : 0;

    return {
        peak,
        rms,
        peakDb: linearToDb(peak),
        rmsDb: linearToDb(rms),
        crestDb: linearToDb(peak) - linearToDb(rms)
    };
}

/* -------------------------
   RÉGLAGES ADAPTATIFS
------------------------- */

function chooseSettings(mode, intensity, stats) {
    const strength = clamp(intensity / 10, 0, 1);

    let settings = {
        highpassHz: 65,
        lowShelfDb: 0,
        mudHz: 260,
        mudDb: -0.5,
        presenceHz: 3200,
        presenceDb: 0.8,
        airDb: 0.4,
        compressorThreshold: -20,
        compressorRatio: 2,
        compressorAttack: 0.018,
        compressorRelease: 0.18,
        outputDb: 0
    };

    if (mode === "voice") {
        settings = {
            ...settings,
            highpassHz: 75,
            lowShelfDb: -0.4,
            mudHz: 280,
            mudDb: -1.1,
            presenceHz: 3400,
            presenceDb: 1.1,
            airDb: 0.6,
            compressorThreshold: -22,
            compressorRatio: 2.2
        };
    }

    if (mode === "rap") {
        settings = {
            ...settings,
            highpassHz: 65,
            lowShelfDb: 0.3,
            mudHz: 300,
            mudDb: -0.8,
            presenceHz: 2800,
            presenceDb: 1.4,
            airDb: 0.5,
            compressorThreshold: -20,
            compressorRatio: 2.4
        };
    }

    /*
     * Si le fichier est déjà très fort, on réduit légèrement
     * l'agressivité du traitement dynamique.
     */
    if (stats.rmsDb > -12) {
        settings.compressorThreshold += 2;
    }

    /*
     * Intensité basse = corrections plus discrètes.
     * Les valeurs sont volontairement limitées pour éviter
     * de dénaturer le son.
     */
    settings.lowShelfDb *= strength;
    settings.mudDb *= strength;
    settings.presenceDb *= strength;
    settings.airDb *= strength;

    settings.compressorRatio =
        1 + (settings.compressorRatio - 1) * strength;

    return settings;
}

/* -------------------------
   CONSTRUCTION DES FILTRES
------------------------- */

function createFilter(context, type, frequency, gain = 0, q = 0.707) {
    const filter = context.createBiquadFilter();

    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;

    if (type === "peaking" ||
        type === "lowshelf" ||
        type === "highshelf") {
        filter.gain.value = gain;
    }

    return filter;
}

/* -------------------------
   TRAITEMENT PRINCIPAL
------------------------- */

async function processAudio() {
    if (!sourceFile || processing) return;

    processing = true;
    processBtn.disabled = true;
    processBtn.textContent = "⏳ Traitement en cours…";

    let decodeContext = null;

    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        const OfflineContextClass =
            window.OfflineAudioContext ||
            window.webkitOfflineAudioContext;

        if (!AudioContextClass || !OfflineContextClass) {
            throw new Error(
                "Ton navigateur ne prend pas en charge le traitement audio."
            );
        }

        setStatus("LECTURE DU FICHIER");

        decodeContext = new AudioContextClass();

        const bytes = await sourceFile.arrayBuffer();
        const inputBuffer = await decodeContext.decodeAudioData(bytes);

        if (!inputBuffer.length || !inputBuffer.duration) {
            throw new Error("Le fichier audio semble vide ou invalide.");
        }

        /*
         * On conserve la fréquence d'échantillonnage d'origine.
         * Cela évite un rééchantillonnage inutile.
         */
        const sampleRate = inputBuffer.sampleRate;

        /*
         * Le navigateur traite en stéréo.
         * Un fichier mono sera adapté par le navigateur.
         */
        const channels = 2;
        const frameCount = Math.ceil(inputBuffer.duration * sampleRate);

        /*
         * Limite préventive : le traitement hors ligne peut
         * consommer beaucoup de mémoire pour les fichiers longs.
         */
        if (inputBuffer.duration > 600) {
            throw new Error(
                "Le fichier dépasse 10 minutes. Essaie avec un extrait plus court."
            );
        }

        setStatus("ANALYSE DU SON");

        const stats = analyzeBuffer(inputBuffer);

        const modeElement = $("mode");
        const mode = modeElement ? modeElement.value : "balanced";

        const intensityElement = $("intensity");
        const intensity = intensityElement
            ? Number(intensityElement.value)
            : 3;

        const settings = chooseSettings(mode, intensity, stats);

        setStatus("AMÉLIORATION DU SON");

        const offline = new OfflineContextClass(
            channels,
            frameCount,
            sampleRate
        );

        const source = offline.createBufferSource();
        source.buffer = inputBuffer;

        // 1. Filtre passe-haut : réduit les graves inutiles.
        const highpass = createFilter(
            offline,
            "highpass",
            settings.highpassHz
        );

        // 2. Équilibre des basses.
        const lowShelf = createFilter(
            offline,
            "lowshelf",
            115,
            settings.lowShelfDb
        );

        // 3. Réduction douce du bas-médium.
        const mud = createFilter(
            offline,
            "peaking",
            settings.mudHz,
            settings.mudDb,
            0.85
        );

        // 4. Présence de la voix.
        const presence = createFilter(
            offline,
            "peaking",
            settings.presenceHz,
            settings.presenceDb,
            0.8
        );

        // 5. Réduction très légère de la zone sifflante.
        const deEss = createFilter(
            offline,
            "peaking",
            7000,
            mode === "voice" ? -0.6 : -0.25,
            1.2
        );

        // 6. Aération discrète.
        const air = createFilter(
            offline,
            "highshelf",
            10000,
            settings.airDb
        );

        // 7. Compression pour contrôler les variations de niveau.
        const compressor = offline.createDynamicsCompressor();

        compressor.threshold.value = settings.compressorThreshold;
        compressor.knee.value = 18;
        compressor.ratio.value = settings.compressorRatio;
        compressor.attack.value = settings.compressorAttack;
        compressor.release.value = settings.compressorRelease;

        // 8. Sécurité supplémentaire contre les pics.
        const peakSafety = offline.createDynamicsCompressor();

        peakSafety.threshold.value = -3;
        peakSafety.knee.value = 3;
        peakSafety.ratio.value = 8;
        peakSafety.attack.value = 0.003;
        peakSafety.release.value = 0.08;

        // 9. Gain de sortie.
        const output = offline.createGain();

        output.gain.value = dbToLinear(settings.outputDb);

        /*
         * Chaîne de traitement :
         * source → filtres → compression → sécurité → sortie
         */
        source.connect(highpass);
        highpass.connect(lowShelf);
        lowShelf.connect(mud);
        mud.connect(presence);
        presence.connect(deEss);
        deEss.connect(air);
        air.connect(compressor);
        compressor.connect(peakSafety);
        peakSafety.connect(output);
        output.connect(offline.destination);

        source.start(0);

        const renderedBuffer = await offline.startRendering();

        setStatus("PRÉPARATION DU FICHIER");

        /*
         * Vérifie le niveau de crête après traitement.
         * Si nécessaire, applique une réduction de gain globale
         * avant l'export afin d'éviter l'écrêtage numérique.
         */
        const renderedStats = analyzeBuffer(renderedBuffer);

        let finalBuffer = renderedBuffer;

        if (renderedStats.peak > dbToLinear(-1)) {
            const reduction = dbToLinear(-1) / renderedStats.peak;

            finalBuffer = await applyOutputGain(
                renderedBuffer,
                reduction,
                OfflineContextClass
            );
        }

        processedBlob = audioBufferToWav24(finalBuffer);

        revokeUrl(processedUrl);
        processedUrl = URL.createObjectURL(processedBlob);

        player.src = processedUrl;
        player.load();

        setActiveTab("processed");

        $("resultTitle").textContent = "Ton son est prêt";
        $("resultSubtitle").textContent =
            "Version améliorée — export WAV 24 bits";

        $("resultNote").textContent =
            "Traitement local terminé. Écoute le résultat et compare-le à l'original.";

        downloadBtn.disabled = false;

        setStatus("TRAITEMENT TERMINÉ", true);

    } catch (error) {
        console.error("SHOUMAC STUDIO :", error);

        setStatus("ERREUR DE TRAITEMENT");

        alert(
            error && error.message
                ? error.message
                : "Une erreur est survenue pendant le traitement."
        );

    } finally {
        if (decodeContext) {
            await decodeContext.close().catch(() => {});
        }

        processing = false;
        processBtn.disabled = !sourceFile;
        processBtn.textContent = DEFAULT_PROCESS_TEXT;
    }
}

/* -------------------------
   GAIN DE SORTIE
------------------------- */

async function applyOutputGain(buffer, gain, OfflineContextClass) {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const sampleRate = buffer.sampleRate;

    const offline = new OfflineContextClass(
        channels,
        frames,
        sampleRate
    );

    const source = offline.createBufferSource();
    const output = offline.createGain();

    source.buffer = buffer;
    output.gain.value = gain;

    source.connect(output);
    output.connect(offline.destination);
    source.start(0);

    return await offline.startRendering();
}

/* -------------------------
   EXPORT WAV 24 BITS
------------------------- */

function audioBufferToWav24(buffer) {
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const frames = buffer.length;
    const bytesPerSample = 3;

    const dataSize = frames * channels * bytesPerSample;
    const headerSize = 44;

    const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, text) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);

    const byteRate = sampleRate * channels * bytesPerSample;

    view.setUint32(28, byteRate, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 24, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = headerSize;

    for (let i = 0; i < frames; i++) {
        for (let channel = 0; channel < channels; channel++) {
            let sample = clamp(
                buffer.getChannelData(channel)[i],
                -1,
                1
            );

            /*
             * Conversion en entier signé sur 24 bits.
             */
            let value = sample < 0
                ? Math.round(sample * 8388608)
                : Math.round(sample * 8388607);

            value = clamp(value, -8388608, 8388607);

            view.setUint8(offset++, value & 0xFF);
            view.setUint8(offset++, (value >> 8) & 0xFF);
            view.setUint8(offset++, (value >> 16) & 0xFF);
        }
    }

    return new Blob(
        [arrayBuffer],
        { type: "audio/wav" }
    );
}

/* -------------------------
   IMPORT AUDIO
------------------------- */

function setFile(file) {
    if (!file) return;

    /*
     * Certains navigateurs ne renseignent pas toujours le MIME.
     * On vérifie aussi l'extension.
     */
    const validExtension =
        /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac)$/i.test(file.name);

    if (
        file.type &&
        !file.type.startsWith("audio/") &&
        !validExtension
    ) {
        alert("Choisis un fichier audio valide.");
        fileInput.value = "";
        return;
    }

    if (!file.type && !validExtension) {
        alert("Format audio non reconnu.");
        fileInput.value = "";
        return;
    }

    sourceFile = file;

    revokeUrl(originalUrl);
    resetProcessedAudio();

    originalUrl = URL.createObjectURL(file);

    $("fileMeta").classList.remove("hidden");
    $("fileName").textContent = file.name;
    $("fileSize").textContent =
        formatBytes(file.size) + " • traitement local";

    $("resultTitle").textContent =
        file.name.replace(/\.[^.]+$/, "");

    $("resultSubtitle").textContent = "Version originale";

    $("resultNote").textContent =
        "Le traitement est effectué dans ton navigateur. " +
        "Pour traiter uniquement la voix, importe une piste voix seule.";

    player.src = originalUrl;
    player.load();

    setActiveTab("original");

    processBtn.disabled = false;
    processBtn.textContent = DEFAULT_PROCESS_TEXT;

    setStatus("FICHIER CHARGÉ");
}

/* -------------------------
   ÉVÉNEMENTS
------------------------- */

fileInput.addEventListener("change", (event) => {
    setFile(event.target.files[0]);
});

processBtn.addEventListener("click", processAudio);

$("removeFile").addEventListener("click", () => {
    if (processing) return;

    sourceFile = null;
    fileInput.value = "";

    $("fileMeta").classList.add("hidden");

    player.pause();
    player.removeAttribute("src");
    player.load();

    revokeUrl(originalUrl);
    originalUrl = null;

    resetProcessedAudio();

    processBtn.disabled = true;
    processBtn.textContent = DEFAULT_PROCESS_TEXT;
    downloadBtn.disabled = true;

    $("resultTitle").textContent = "Ton morceau apparaîtra ici";
    $("resultSubtitle").textContent = "Importe un audio pour commencer";
    $("resultNote").textContent =
        "Le traitement est effectué localement dans ton navigateur.";

    setStatus("EN ATTENTE");
});

$("intensity").addEventListener("input", (event) => {
    $("intensityValue").textContent = event.target.value + "/10";
});

document.querySelectorAll(".compare-tab").forEach((button) => {
    button.addEventListener("click", () => {
        const type = button.dataset.source;

        if (type === "processed" && !processedUrl) {
            alert("Traite d'abord ton morceau.");
            return;
        }

        const url = type === "processed"
            ? processedUrl
            : originalUrl;

        if (!url) return;

        player.src = url;
        player.load();

        setActiveTab(type);

        $("resultSubtitle").textContent =
            type === "processed"
                ? "Version améliorée"
                : "Version originale";
    });
});

downloadBtn.addEventListener("click", () => {
    if (!processedBlob) return;

    const link = document.createElement("a");

    link.href = processedUrl;
    link.download =
        sourceFile.name.replace(/\.[^.]+$/, "") +
        "_SHOUMAC_STUDIO.wav";

    document.body.appendChild(link);
    link.click();
    link.remove();
});

/* -------------------------
   INITIALISATION
------------------------- */

processBtn.disabled = true;
downloadBtn.disabled = true;

if ($("intensityValue") && $("intensity")) {
    $("intensityValue").textContent =
        $("intensity").value + "/10";
}

setStatus("EN ATTENTE");
