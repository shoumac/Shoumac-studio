const fileInput = document.getElementById("audioFile");
const processBtn = document.getElementById("processBtn");
const downloadBtn = document.getElementById("downloadBtn");
const player = document.getElementById("audioPlayer");

let sourceFile = null;
let originalUrl = null;
let processedUrl = null;
let processedBlob = null;

const $ = (id) => document.getElementById(id);

// --------------------------------------------------
// UTILITAIRES
// --------------------------------------------------

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

// --------------------------------------------------
// IMPORT AUDIO
// --------------------------------------------------

function setFile(file) {
    if (!file) return;

    if (!file.type.startsWith("audio/")) {
        alert("Choisis un fichier audio valide.");
        fileInput.value = "";
        return;
    }

    sourceFile = file;

    revokeUrl(originalUrl);
    revokeUrl(processedUrl);

    originalUrl = URL.createObjectURL(file);
    processedUrl = null;
    processedBlob = null;

    $("fileMeta").classList.remove("hidden");
    $("fileName").textContent = file.name;
    $("fileSize").textContent =
        formatBytes(file.size) + " • traitement local";

    $("resultTitle").textContent =
        file.name.replace(/\.[^.]+$/, "");

    $("resultSubtitle").textContent = "Original prêt à écouter";

    $("resultNote").textContent =
        "Pour améliorer uniquement une voix, importe de préférence une piste voix seule.";

    setStatus("FICHIER CHARGÉ");

    player.src = originalUrl;
    player.load();

    setActiveTab("original");

    processBtn.disabled = false;
    processBtn.textContent = "⚡ Améliorer mon son";

    downloadBtn.disabled = true;
}

fileInput.addEventListener("change", (event) => {
    setFile(event.target.files[0]);
});

// --------------------------------------------------
// SUPPRIMER LE FICHIER
// --------------------------------------------------

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

    $("resultTitle").textContent =
        "Ton morceau apparaîtra ici";

    $("resultSubtitle").textContent =
        "Importe un audio pour commencer";

    $("resultNote").textContent =
        "Le traitement est effectué localement dans ton navigateur.";

    setStatus("EN ATTENTE");
});

// --------------------------------------------------
// INTENSITÉ
// --------------------------------------------------

$("intensity").addEventListener("input", (event) => {
    $("intensityValue").textContent =
        event.target.value + "/10";
});

// --------------------------------------------------
// COMPARAISON ORIGINAL / TRAITÉ
// --------------------------------------------------

function setActiveTab(type) {
    document.querySelectorAll(".compare-tab").forEach((tab) => {
        tab.classList.toggle(
            "active",
            tab.dataset.source === type
        );
    });
}

document.querySelectorAll(".compare-tab").forEach((button) => {
    button.addEventListener("click", () => {
        const type = button.dataset.source;

        if (type === "processed" && !processedUrl) {
            alert("Traite d'abord ton morceau.");
            return;
        }

        player.src =
            type === "processed"
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

// --------------------------------------------------
// TRAITEMENT AUDIO
// --------------------------------------------------

processBtn.addEventListener("click", async () => {
    if (!sourceFile) return;

    processBtn.disabled = true;
    processBtn.textContent = "⏳ Traitement en cours…";

    setStatus("ANALYSE EN COURS");

    let decodeContext;

    try {
        const AudioContextClass =
            window.AudioContext ||
            window.webkitAudioContext;

        const OfflineContext =
            window.OfflineAudioContext ||
            window.webkitOfflineAudioContext;

        if (!AudioContextClass || !OfflineContext) {
            throw new Error(
                "Ton navigateur ne prend pas en charge le traitement audio."
            );
        }

        // Décodage du fichier importé
        decodeContext = new AudioContextClass();

        const inputBuffer = await decodeContext.decodeAudioData(
            await sourceFile.arrayBuffer()
        );

        // Réglages
        const mode = $("mode").value;

        const intensity =
            Number($("intensity").value) / 10;

        const sampleRate = Math.min(
            Math.max(inputBuffer.sampleRate, 44100),
            96000
        );

        const frameCount =
            Math.ceil(inputBuffer.duration * sampleRate);

        const offline = new OfflineContext(
            2,
            frameCount,
            sampleRate
        );

        const source = offline.createBufferSource();
        source.buffer = inputBuffer;

        // Modes de traitement
        const voiceOnly = mode === "voice";
        const rapMode = mode === "rap";

        // 1. Filtre passe-haut
        const highpass = offline.createBiquadFilter();

        highpass.type = "highpass";

        highpass.frequency.value =
            voiceOnly ? 65 : 28;

        highpass.Q.value = 0.707;

        // 2. Contrôle des basses
        const bass = offline.createBiquadFilter();

        bass.type = "lowshelf";
        bass.frequency.value = 115;

        bass.gain.value =
            (voiceOnly ? -0.3 : rapMode ? 0.45 : 0.1)
            * intensity;

        // 3. Réduction légère des fréquences brouillonnes
        const mud = offline.createBiquadFilter();

        mud.type = "peaking";

        mud.frequency.value =
            voiceOnly ? 260 : 300;

        mud.Q.value = 0.85;

        mud.gain.value =
            -(voiceOnly ? 1.0 : rapMode ? 0.7 : 0.4)
            * intensity;

        // 4. Présence et intelligibilité
        const presence = offline.createBiquadFilter();

        presence.type = "peaking";

        presence.frequency.value =
            voiceOnly ? 3200 : 2800;

        presence.Q.value = 0.8;

        presence.gain.value =
            (voiceOnly ? 1.2 : rapMode ? 0.8 : 0.3)
            * intensity;

        // 5. Légère ouverture des aigus
        const air = offline.createBiquadFilter();

        air.type = "highshelf";
        air.frequency.value = 10000;

        air.gain.value =
            (voiceOnly ? 0.45 : 0.2) * intensity;

        // 6. Compression
        const compressor =
            offline.createDynamicsCompressor();

        compressor.threshold.value =
            voiceOnly ? -22 : rapMode ? -18 : -16;

        compressor.knee.value = 18;

        compressor.ratio.value =
            voiceOnly ? 2.1 : rapMode ? 2.5 : 1.6;

        compressor.attack.value = 0.018;
        compressor.release.value = 0.16;

        // 7. Gain de compensation modéré
        const makeup = offline.createGain();

        makeup.gain.value =
            voiceOnly ? 1.08 : rapMode ? 1.04 : 1.0;

        // 8. Réduction de niveau pour garder une marge
        const outputGain = offline.createGain();

        outputGain.gain.value = 0.92;

        // Connexion de la chaîne audio
        source.connect(highpass);
        highpass.connect(bass);
        bass.connect(mud);
        mud.connect(presence);
        presence.connect(air);
        air.connect(compressor);
        compressor.connect(makeup);
        makeup.connect(outputGain);
        outputGain.connect(offline.destination);

        source.start(0);

        // Rendu final
        const rendered = await offline.startRendering();

        // Analyse du niveau
        const analysis = analyzeBuffer(rendered);

        // Export WAV 24 bits avec marge de sécurité
        processedBlob = audioBufferToWav24(
            rendered,
            0.891250938
        );

        revokeUrl(processedUrl);

        processedUrl = URL.createObjectURL(
            processedBlob
        );

        player.src = processedUrl;
        player.load();

        setActiveTab("processed");

        setStatus("TRAITEMENT TERMINÉ", true);

        $("resultSubtitle").textContent =
            "Version traitée • écoute avant export";

        $("resultNote").textContent =
            "Crête : " + analysis.peakDb.toFixed(1) +
            " dBFS • RMS : " + analysis.rmsDb.toFixed(1) +
            " dBFS. Le résultat dépend de la qualité de l'enregistrement.";

        downloadBtn.disabled = false;

        processBtn.textContent =
            "↻ Refaire le traitement";

        processBtn.disabled = false;

    } catch (error) {
        console.error(error);

        alert(
            "Le traitement a échoué : " + error.message
        );

        processBtn.textContent =
            "⚡ Améliorer mon son";

        processBtn.disabled = false;

        setStatus("ERREUR");

    } finally {
        if (decodeContext) {
            await decodeContext.close().catch(() => {});
        }
    }
});

// --------------------------------------------------
// EXPORT WAV 24 BITS
// --------------------------------------------------

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

// --------------------------------------------------
// ANALYSE DU SIGNAL
// --------------------------------------------------

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

            peak = Math.max(peak, Math.abs(value));

            sumSquares += value * value;

            count++;
        }
    }

    const rms = Math.sqrt(
        sumSquares / Math.max(count, 1)
    );

    return {
        peakDb:
            peak > 0
                ? 20 * Math.log10(peak)
                : -Infinity,

        rmsDb:
            rms > 0
                ? 20 * Math.log10(rms)
                : -Infinity
    };
}

// --------------------------------------------------
// ENCODAGE WAV 24 BITS
// --------------------------------------------------

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
        for (let i = 0; i < text.length; i++) {
            view.setUint8(
                offset + i,
                text.charCodeAt(i)
            );
        }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);

    writeString(8, "WAVE");
    writeString(12, "fmt ");

    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);

    view.setUint32(
        24,
        buffer.sampleRate,
        true
    );

    view.setUint32(
        28,
        buffer.sampleRate * channels * bytesPerSample,
        true
    );

    view.setUint16(
        32,
        channels * bytesPerSample,
        true
    );

    view.setUint16(34, 24, true);

    writeString(36, "data");
    view.setUint32(40, dataBytes, true);

    const peak = getPeak(buffer);

    const scale =
        peak > ceiling
            ? ceiling / peak
            : 1;

    let offset = 44;

    for (let frame = 0; frame < frames; frame++) {
        for (
            let channel = 0;
            channel < channels;
            channel++
        ) {
            let sample =
                buffer.getChannelData(channel)[frame]
                * scale;

            sample = Math.max(
                -1,
                Math.min(1, sample)
            );

            const intSample =
                sample < 0
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
