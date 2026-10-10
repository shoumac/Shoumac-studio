const fileInput = document.getElementById("audioFile");
const processBtn = document.getElementById("processBtn");
const downloadBtn = document.getElementById("downloadBtn");
const player = document.getElementById("audioPlayer");

let sourceFile = null;
let originalUrl = null;
let processedUrl = null;
let processedBlob = null;
let selectedOutput = "original";

const $ = (id) => document.getElementById(id);

// ============================================
// OUTILS GÉNÉRAUX
// ============================================

function formatBytes(bytes) {
    return bytes < 1048576
        ? Math.round(bytes / 1024) + " Ko"
        : (bytes / 1048576).toFixed(1) + " Mo";
}

function setStatus(message, ready = false) {
    $("status").textContent = message;
    $("status").classList.toggle("ready", ready);
}

function revokeUrl(url) {
    if (url) URL.revokeObjectURL(url);
}

function fmtDb(value) {
    return Number.isFinite(value) ? value.toFixed(1) : "—";
}

// ============================================
// IMPORT AUDIO
// ============================================

function setFile(file) {
    if (!file) return;

    if (!file.type.startsWith("audio/")) {
        alert("Choisis un fichier audio valide : WAV, MP3, M4A, etc.");
        fileInput.value = "";
        return;
    }

    sourceFile = file;

    revokeUrl(originalUrl);
    revokeUrl(processedUrl);

    originalUrl = URL.createObjectURL(file);
    processedUrl = null;
    processedBlob = null;

    selectedOutput = "original";

    $("fileMeta").classList.remove("hidden");
    $("fileName").textContent = file.name;
    $("fileSize").textContent = formatBytes(file.size) + " • traitement local";

    $("resultTitle").textContent = file.name.replace(/\.[^.]+$/, "");
    $("resultSubtitle").textContent = "Original prêt à écouter";

    $("resultNote").textContent =
        "Conseil : pour travailler la voix sans modifier l'instrumentale, importe une piste voix seule.";

    setStatus("FICHIER CHARGÉ");

    player.src = originalUrl;
    player.load();

    setActiveTab("original");

    processBtn.disabled = false;
    processBtn.textContent = "⚡ Améliorer mon son";

    downloadBtn.disabled = true;
}

function setActiveTab(type) {
    selectedOutput = type;

    document.querySelectorAll(".compare-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.source === type);
    });
}

fileInput.addEventListener("change", (event) => {
    setFile(event.target.files[0]);
});

// ============================================
// SUPPRESSION DU FICHIER
// ============================================

$("removeFile").addEventListener("click", () => {
    sourceFile = null;
    fileInput.value = "";

    $("fileMeta").classList.add("hidden");

    player.removeAttribute("src");
    player.load();

    processBtn.disabled = true;
    downloadBtn.disabled = true;

    processBtn.textContent = "⚡ Améliorer mon son";

    revokeUrl(originalUrl);
    revokeUrl(processedUrl);

    originalUrl = null;
    processedUrl = null;
    processedBlob = null;

    setStatus("EN ATTENTE");

    $("resultTitle").textContent = "Ton morceau apparaîtra ici";
    $("resultSubtitle").textContent = "Importe un audio pour commencer";

    $("resultNote").textContent =
        "Le traitement est effectué localement dans ton navigateur.";
});

// ============================================
// RÉGLAGE DE L'INTENSITÉ
// ============================================

$("intensity").addEventListener("input", (event) => {
    $("intensityValue").textContent = event.target.value + "/10";
});

// ============================================
// COMPARAISON ORIGINAL / VERSION TRAITÉE
// ============================================

document.querySelectorAll(".compare-tab").forEach((button) => {
    button.addEventListener("click", () => {
        const type = button.dataset.source;

        if (type === "processed" && !processedUrl) {
            alert("Traite d'abord ton morceau.");
            return;
        }

        player.src = type === "processed"
            ? processedUrl
            : originalUrl;

        player.load();

        setActiveTab(type);

        $("resultSubtitle").textContent =
            type === "processed"
                ? "Version traitée"
                : "Version originale";
    });
});

// ============================================
// MOTEUR AUDIO PRO MAX
// ============================================

processBtn.addEventListener("click", async () => {
    if (!sourceFile) return;

    processBtn.disabled = true;
    processBtn.textContent = "⏳ Analyse et traitement…";

    setStatus("ANALYSE EN COURS");

    let decodeContext;

    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        const OfflineContextClass =
            window.OfflineAudioContext ||
            window.webkitOfflineAudioContext;

        if (!AudioContextClass || !OfflineContextClass) {
            throw new Error(
                "Ce navigateur ne prend pas en charge le traitement audio nécessaire."
            );
        }

        // Décodage du fichier original
        decodeContext = new AudioContextClass();

        await decodeContext.resume().catch(() => {});

        const inputBytes = await sourceFile.arrayBuffer();

        const inputBuffer =
            await decodeContext.decodeAudioData(inputBytes);

        // Paramètres utilisateur
        const mode = $("mode").value;

        const intensity =
            Number($("intensity").value) / 10;

        const strength = Math.max(
            0,
            Math.min(1, intensity)
        );

        // Fréquence d'échantillonnage
        const sampleRate = Math.min(
            Math.max(inputBuffer.sampleRate, 44100),
            96000
        );

        const channels = 2;

        const frameCount = Math.ceil(
            inputBuffer.duration * sampleRate
        );

        // Création du moteur audio hors ligne
        const offline = new OfflineContextClass(
            channels,
            frameCount,
            sampleRate
        );

        const source = offline.createBufferSource();

        source.buffer = inputBuffer;

        // Analyse du fichier original
        const inputStats = analyzeBuffer(inputBuffer);

        const spectrum = analyzeSpectrum(inputBuffer);

        // Réglages adaptés au profil choisi
        const adaptive = chooseAdaptiveSettings({
            mode,
            strength,
            stats: inputStats,
            spectrum
        });

        // ========================================
        // 1. FILTRE PASSE-HAUT
        // Réduction douce des fréquences très basses
        // ========================================

        const highpass = offline.createBiquadFilter();

        highpass.type = "highpass";
        highpass.frequency.value = adaptive.highpassHz;
        highpass.Q.value = 0.707;

        // ========================================
        // 2. ÉGALISATION DES BASSES
        // ========================================

        const lowShelf = offline.createBiquadFilter();

        lowShelf.type = "lowshelf";
        lowShelf.frequency.value = 115;
        lowShelf.gain.value = adaptive.lowShelfDb;

        // ========================================
        // 3. RÉDUCTION DU SON BOUEUX
        // ========================================

        const mud = offline.createBiquadFilter();

        mud.type = "peaking";
        mud.frequency.value = adaptive.mudHz;
        mud.Q.value = 0.85;
        mud.gain.value = adaptive.mudDb;

        // ========================================
        // 4. PRÉSENCE ET CLARTÉ
        // ========================================

        const presence = offline.createBiquadFilter();

        presence.type = "peaking";
        presence.frequency.value = adaptive.presenceHz;
        presence.Q.value = 0.8;
        presence.gain.value = adaptive.presenceDb;

        // ========================================
        // 5. ATTÉNUATION DOUCE DES SIBILANCES
        // Approximation par égalisation
        // ========================================

        const deEssBand = offline.createBiquadFilter();

        deEssBand.type = "peaking";

        deEssBand.frequency.value =
            mode === "voice" ? 6800 : 7200;

        deEssBand.Q.value = 1.25;

        deEssBand.gain.value =
            mode === "voice"
                ? -0.65 * strength
                : -0.25 * strength;

        // ========================================
        // 6. AIR ET BRILLANCE
        // ========================================

        const air = offline.createBiquadFilter();

        air.type = "highshelf";
        air.frequency.value = 10000;
        air.gain.value = adaptive.airDb;

        // ========================================
        // 7. COMPRESSION PRINCIPALE
        // ========================================

        const compressor = offline.createDynamicsCompressor();

        compressor.threshold.value = adaptive.thresholdDb;
        compressor.knee.value = adaptive.kneeDb;
        compressor.ratio.value = adaptive.ratio;
        compressor.attack.value = adaptive.attackSec;
        compressor.release.value = adaptive.releaseSec;

        // ========================================
        // 8. GAIN DE COMPENSATION
        // ========================================

        const makeup = offline.createGain();

        makeup.gain.value = adaptive.makeupGain;

        // ========================================
        // 9. COMPRESSEUR DE SÉCURITÉ
        // ========================================

        const peakSafety =
            offline.createDynamicsCompressor();

        peakSafety.threshold.value = -3;
        peakSafety.knee.value = 2;
        peakSafety.ratio.value = 8;
        peakSafety.attack.value = 0.003;
        peakSafety.release.value = 0.08;

        // ========================================
        // CONNEXION DE LA CHAÎNE AUDIO
        // ========================================

        source.connect(highpass);

        highpass.connect(lowShelf);

        lowShelf.connect(mud);

        mud.connect(presence);

        presence.connect(deEssBand);

        deEssBand.connect(air);

        air.connect(compressor);

        compressor.connect(makeup);

        makeup.connect(peakSafety);

        peakSafety.connect(offline.destination);

        // Lancement du traitement
        source.start(0);

        const rendered = await offline.startRendering();

        // ========================================
        // ANALYSE DU RÉSULTAT
        // ========================================

        const analysis = analyzeBuffer(rendered);

        const loudness = estimateLoudness(rendered);

        // Export WAV 24 bits
        processedBlob = audioBufferToWav24(
            rendered,
            0.891250938
        );

        revokeUrl(processedUrl);

        processedUrl = URL.createObjectURL(processedBlob);

        // Lecture de la version traitée
        player.src = processedUrl;
        player.load();

        setActiveTab("processed");

        setStatus("TRAITEMENT TERMINÉ", true);

        $("resultSubtitle").textContent =
            "Version traitée • écoute avant export";

        $("resultNote").textContent =
            `Crête : ${fmtDb(analysis.peakDb)} dBFS • ` +
            `RMS : ${fmtDb(analysis.rmsDb)} dBFS • ` +
            `Sonie estimée : ${fmtDb(loudness.integratedLufs)} LUFS • ` +
            `Crest factor : ${fmtDb(analysis.crestDb)} dB. ` +
            `Profil : ${adaptive.label}. ` +
            `La mesure LUFS est indicative et ne remplace pas une mesure normalisée.`;

        downloadBtn.disabled = false;

        processBtn.textContent = "↻ Refaire le traitement";

        processBtn.disabled = false;

    } catch (error) {
        console.error(error);

        alert(
            "Le traitement a échoué : " + error.message
        );

        processBtn.textContent = "⚡ Améliorer mon son";

        processBtn.disabled = false;

        setStatus("ERREUR");

    } finally {
        if (decodeContext) {
            await decodeContext.close().catch(() => {});
        }
    }
});

// ============================================
// EXPORT WAV 24 BITS
// ============================================

downloadBtn.addEventListener("click", () => {
    if (!processedUrl || !sourceFile) return;

    const link = document.createElement("a");

    link.href = processedUrl;

    link.download =
        sourceFile.name.replace(/\.[^.]+$/, "") +
        "_SHOUMAC_MASTER_24bit.wav";

    document.body.appendChild(link);

    link.click();

    link.remove();
});

// ============================================
// ANALYSE AUDIO : CRÊTE, RMS ET DYNAMIQUE
// ============================================

function analyzeBuffer(buffer) {
    let peak = 0;
    let sumSquares = 0;
    let count = 0;

    for (
        let channel = 0;
        channel < buffer.numberOfChannels;
        channel++
    ) {
        const data = buffer.getChannelData(channel);

        for (let i = 0; i < data.length; i++) {
            const value = data[i];

            peak = Math.max(
                peak,
                Math.abs(value)
            );

            sumSquares += value * value;

            count++;
        }
    }

    const rms = Math.sqrt(
        sumSquares / Math.max(count, 1)
    );

    const peakDb = peak > 0
        ? 20 * Math.log10(peak)
        : -Infinity;

    const rmsDb = rms > 0
        ? 20 * Math.log10(rms)
        : -Infinity;

    return {
        peak,
        rms,
        peakDb,
        rmsDb,

        crestDb:
            Number.isFinite(peakDb) &&
            Number.isFinite(rmsDb)
                ? peakDb - rmsDb
                : -Infinity
    };
}

// ============================================
// ANALYSE APPROXIMATIVE DES BANDES
// ============================================

function analyzeSpectrum(buffer) {
    const sampleRate = buffer.sampleRate;

    const bins = {
        low: 0,
        mud: 0,
        presence: 0,
        high: 0,
        total: 0
    };

    const stride = Math.max(
        1,
        Math.floor(buffer.length / 120000)
    );

    for (
        let channel = 0;
        channel < buffer.numberOfChannels;
        channel++
    ) {
        const data = buffer.getChannelData(channel);

        let previous = 0;

        for (
            let i = 0;
            i < data.length;
            i += stride
        ) {
            const value = data[i];

            const difference = value - previous;

            const frequencyProxy =
                Math.abs(difference) * sampleRate;

            const power = value * value;

            bins.total += power;

            if (frequencyProxy < 180) {
                bins.low += power;
            } else if (frequencyProxy < 900) {
                bins.mud += power;
            } else if (frequencyProxy < 5000) {
                bins.presence += power;
            } else {
                bins.high += power;
            }

            previous = value;
        }
    }

    const total = Math.max(
        bins.total,
        1e-12
    );

    return {
        lowRatio: bins.low / total,
        mudRatio: bins.mud / total,
        presenceRatio: bins.presence / total,
        highRatio: bins.high / total
    };
}

// ============================================
// RÉGLAGES ADAPTATIFS
// ============================================

function chooseAdaptiveSettings({
    mode,
    strength,
    stats,
    spectrum
}) {
    const voice = mode === "voice";
    const rap = mode === "rap";

    const headroom = Number.isFinite(stats.peakDb)
        ? Math.max(
            0,
            Math.min(1, (0 - stats.peakDb) / 12)
        )
        : 0.5;

    const density = Number.isFinite(stats.crestDb)
        ? Math.max(
            0,
            Math.min(1, (stats.crestDb - 4) / 12)
        )
        : 0.5;

    const presenceCorrection =
        spectrum.presenceRatio > 0.62
            ? 0.45
            : 1;

    const airCorrection =
        spectrum.highRatio > 0.22
            ? 0.35
            : 1;

    return {
        label: voice
            ? "Voix naturelle"
            : rap
                ? "Rap / Trap / Drill"
                : "Master équilibré",

        highpassHz: voice ? 65 : 28,

        lowShelfDb:
            (voice
                ? -0.2
                : rap
                    ? 0.45
                    : 0.1) * strength,

        mudHz: voice ? 260 : 300,

        mudDb:
            -(voice
                ? 0.8
                : rap
                    ? 0.55
                    : 0.35) *
            strength *
            (spectrum.mudRatio > 0.24 ? 1.15 : 0.7),

        presenceHz: voice ? 3200 : 2800,

        presenceDb:
            (voice
                ? 0.95
                : rap
                    ? 0.7
                    : 0.25) *
            strength *
            presenceCorrection,

        airDb:
            (voice ? 0.35 : 0.15) *
            strength *
            airCorrection,

        thresholdDb:
            voice
                ? -23
                : rap
                    ? -18
                    : -16,

        kneeDb: voice ? 16 : 12,

        ratio:
            voice
                ? 2.0
                : rap
                    ? 2.4
                    : 1.55,

        attackSec: voice ? 0.012 : 0.018,

        releaseSec: voice ? 0.12 : 0.16,

        makeupGain:
            1 +
            (voice
                ? 0.05
                : rap
                    ? 0.035
                    : 0.015) *
            strength *
            (0.55 + 0.45 * density) *
            (0.7 + 0.3 * headroom)
    };
}

// ============================================
// ESTIMATION INDICATIVE DE SONIE
// ATTENTION : CE N'EST PAS UNE MESURE LUFS
// NORMALISÉE SELON ITU-R BS.1770
// ============================================

function estimateLoudness(buffer) {
    const stats = analyzeBuffer(buffer);

    return {
        integratedLufs:
            Number.isFinite(stats.rmsDb)
                ? stats.rmsDb - 0.691
                : -Infinity,

        method: "Approximation basée sur le RMS"
    };
}

// ============================================
// ENCODAGE WAV 24 BITS
// ============================================

function audioBufferToWav24(
    buffer,
    ceiling = 0.891250938
) {
    const channels = Math.min(
        buffer.numberOfChannels,
        2
    );

    const frames = buffer.length;

    const bytesPerSample = 3;

    const dataBytes =
        frames * channels * bytesPerSample;

    const bytes = new ArrayBuffer(
        44 + dataBytes
    );

    const view = new DataView(bytes);

    function writeString(offset, text) {
        for (
            let i = 0;
            i < text.length;
            i++
        ) {
            view.setUint8(
                offset + i,
                text.charCodeAt(i)
            );
        }
    }

    // En-tête RIFF
    writeString(0, "RIFF");

    view.setUint32(
        4,
        36 + dataBytes,
        true
    );

    writeString(8, "WAVE");

    // Bloc de format
    writeString(12, "fmt ");

    view.setUint32(16, 16, true);

    view.setUint16(20, 1, true);

    view.setUint16(
        22,
        channels,
        true
    );

    view.setUint32(
        24,
        buffer.sampleRate,
        true
    );

    view.setUint32(
        28,
        buffer.sampleRate *
        channels *
        bytesPerSample,
        true
    );

    view.setUint16(
        32,
        channels * bytesPerSample,
        true
    );

    view.setUint16(34, 24, true);

    // Bloc de données
    writeString(36, "data");

    view.setUint32(
        40,
        dataBytes,
        true
    );

    // Réduction de gain globale si nécessaire
    const originalPeak = getPeak(buffer);

    const scale = originalPeak > ceiling
        ? ceiling / originalPeak
        : 1;

    let offset = 44;

    for (
        let frame = 0;
        frame < frames;
        frame++
    ) {
        for (
            let channel = 0;
            channel < channels;
            channel++
        ) {
            let sample =
                buffer.getChannelData(channel)[frame] *
                scale;

            sample = Math.max(
                -1,
                Math.min(1, sample)
            );

            const intSample = sample < 0
                ? Math.round(sample * 8388608)
                : Math.round(sample * 8388607);

            view.setUint8(
                offset,
                intSample & 0xff
            );

            view.setUint8(
                offset + 1,
                (intSample >> 8) & 0xff
            );

            view.setUint8(
                offset + 2,
                (intSample >> 16) & 0xff
            );

            offset += 3;
        }
    }

    return new Blob(
        [bytes],
        { type: "audio/wav" }
    );
}

// ============================================
// DÉTECTION DU PIC AUDIO
// ============================================

function getPeak(buffer) {
    let peak = 0;

    for (
        let channel = 0;
        channel < Math.min(buffer.numberOfChannels, 2);
        channel++
    ) {
        const data = buffer.getChannelData(channel);

        for (let i = 0; i < data.length; i++) {
            peak = Math.max(
                peak,
                Math.abs(data[i])
            );
        }
    }

    return peak;
}
