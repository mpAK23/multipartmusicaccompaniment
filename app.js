import { Soundfont } from "https://unpkg.com/smplr/dist/index.mjs";

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileNameDisplay = document.getElementById('file-name');
const partsContainer = document.getElementById('parts-container');
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const exportBtn = document.getElementById('export-btn');
const statusBar = document.getElementById('status-bar');
const visualizer = document.getElementById('visualizer');
const bpmSlider = document.getElementById('bpm-slider');
const bpmVal = document.getElementById('bpm-val');

let currentNotes = [];
let availableParts = [];
let sfInstruments = {}; // Multi-part caching layer
let ac = null;
let masterGain = null;
let isPlaying = false;
let maxTimeQN = 0;

class CustomRecorderSampler {
    constructor(ac, options) {
        this.ac = ac;
        this.destination = options.destination;
        this.samples = {};
        this.activeSources = [];
        this.load = this._loadInternal();
    }

    async _loadInternal() {
        const res = await fetch("https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/recorder-mp3.js");
        const text = await res.text();
        const startIdx = text.indexOf('MIDI.Soundfont.recorder = ') + 'MIDI.Soundfont.recorder = '.length;
        const endIdx = text.lastIndexOf('}');
        let extractedJSON = text.substring(startIdx, endIdx + 1);
        extractedJSON = extractedJSON.replace(/,\s*\}/, '}');
        let allSamples;
        try {
            allSamples = JSON.parse(extractedJSON);
        } catch(e) {
            console.error("Failed to parse samples json", e);
            return;
        }

        const targetNotes = {
            60: "C4",
            72: "C5",
            84: "C6",
            96: "C7"
        };
        
        for (const midi in targetNotes) {
            const noteName = targetNotes[midi];
            if (allSamples[noteName]) {
                const base64 = allSamples[noteName].split(",")[1];
                const arrayBuffer = this._base64ToArrayBuffer(base64);
                const audioBuffer = await this.ac.decodeAudioData(arrayBuffer);
                this.samples[midi] = audioBuffer;
            }
        }
    }

    _base64ToArrayBuffer(base64) {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }

    start({ note, time, duration }) {
        let nearestMidi = null;
        let minDiff = Infinity;
        for (const midiStr in this.samples) {
            const m = parseInt(midiStr);
            const diff = Math.abs(note - m);
            if (diff < minDiff) {
                minDiff = diff;
                nearestMidi = m;
            }
        }

        if (!nearestMidi) return;

        const diffSemis = note - nearestMidi;
        
        const source = this.ac.createBufferSource();
        source.buffer = this.samples[nearestMidi];
        source.playbackRate.value = Math.pow(2, diffSemis / 12);

        const gainNode = this.ac.createGain();
        gainNode.gain.setValueAtTime(0, time);
        
        const attack = Math.min(0.05, duration * 0.3);
        const release = Math.min(0.1, duration * 0.3);
        
        gainNode.gain.linearRampToValueAtTime(1, time + attack);
        gainNode.gain.setValueAtTime(1, time + duration - release);
        gainNode.gain.linearRampToValueAtTime(0, time + duration);

        source.connect(gainNode);
        gainNode.connect(this.destination);

        source.start(time);
        source.stop(time + duration);
        
        this.activeSources.push({ source, gainNode });
    }

    stop() {
        this.activeSources.forEach(({ source, gainNode }) => {
            try { source.stop(); } catch(e){}
            try { source.disconnect(); } catch(e){}
            try { gainNode.disconnect(); } catch(e){}
        });
        this.activeSources = [];
    }
}

for(let i = 0; i < 20; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    visualizer.appendChild(bar);
}
const bars = document.querySelectorAll('.bar');

bpmSlider.addEventListener('input', (e) => {
    bpmVal.textContent = e.target.value;
    if (window.Tone && Tone.Transport) {
        Tone.Transport.bpm.value = parseFloat(e.target.value);
    }
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFile(e.target.files[0]);
    }
});

function renderPartControls(parts) {
    partsContainer.innerHTML = '';
    
    if (parts.length === 0) {
        partsContainer.innerHTML = `
            <div class="control-group">
                <label>No parts detected.</label>
            </div>
        `;
        return;
    }
    
    parts.forEach((part, index) => {
        const group = document.createElement('div');
        group.className = 'control-group';
        
        const friendlyName = part.name || `Track ${index + 1}`;
        const label = document.createElement('label');
        label.textContent = friendlyName;
        
        const selectWrapper = document.createElement('div');
        selectWrapper.className = 'select-wrapper';
        
        const select = document.createElement('select');
        select.className = 'part-instrument-select';
        select.dataset.partId = part.id;
        
        select.innerHTML = `
            <option value="" disabled selected>Select an instrument...</option>
            <optgroup label="Recorder Family">
                <option value="soprano-recorder">Soprano Recorder</option>
                <option value="alto-recorder">Alto Recorder</option>
                <option value="tenor-recorder">Tenor Recorder</option>
                <option value="bass-recorder">Bass Recorder</option>
            </optgroup>
            <optgroup label="Keyboards">
                <option value="acoustic_grand_piano">Piano</option>
                <option value="harpsichord">Harpsichord</option>
            </optgroup>
            <optgroup label="Strings">
                <option value="cello">Cello</option>
            </optgroup>
        `;
        
        select.addEventListener('change', () => {
            // Destroy specific instrument buffer so it gets reloaded safely in prepareAudio
            if (sfInstruments[part.id]) {
                sfInstruments[part.id].stop();
                delete sfInstruments[part.id];
            }
        });
        
        const excludeLabel = document.createElement('label');
        excludeLabel.style.cssText = "display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-muted); font-size: 0.85rem; padding-left: 4px; white-space: nowrap;";
        
        const excludeCheck = document.createElement('input');
        excludeCheck.type = 'checkbox';
        excludeCheck.className = 'exclude-export-chk';
        excludeCheck.dataset.partId = part.id;
        
        excludeLabel.appendChild(excludeCheck);
        excludeLabel.appendChild(document.createTextNode('Exclude on Export'));
        
        const transposeLabel = document.createElement('label');
        transposeLabel.style.cssText = "display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-muted); font-size: 0.85rem; padding-left: 8px; white-space: nowrap;";
        
        const transposeCheck = document.createElement('input');
        transposeCheck.type = 'checkbox';
        transposeCheck.className = 'transpose-chk';
        transposeCheck.dataset.partId = part.id;
        
        const transposeVal = document.createElement('input');
        transposeVal.type = 'number';
        transposeVal.className = 'transpose-val';
        transposeVal.dataset.partId = part.id;
        transposeVal.value = '7'; 
        transposeVal.style.cssText = "width: 40px; font-size: 0.8rem; text-align: center; border: 1px solid var(--border); border-radius: 4px; background: rgba(255, 255, 255, 0.1); color: var(--text-main);";
        
        transposeLabel.appendChild(transposeCheck);
        transposeLabel.appendChild(document.createTextNode('Transpose'));
        transposeLabel.appendChild(transposeVal);
        
        const row = document.createElement('div');
        row.style.cssText = "display: flex; align-items: center; gap: 12px;";
        
        selectWrapper.style.flex = "1";
        selectWrapper.appendChild(select);
        
        row.appendChild(selectWrapper);
        row.appendChild(excludeLabel);
        row.appendChild(transposeLabel);
        
        group.appendChild(label);
        group.appendChild(row);
        partsContainer.appendChild(group);
    });
}

function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.xml') && !file.name.toLowerCase().endsWith('.musicxml')) {
        updateStatus('Please upload a valid .xml or .musicxml file.', true);
        return;
    }
    
    fileNameDisplay.style.display = 'inline-block';
    fileNameDisplay.textContent = file.name;
    updateStatus('Parsing MusicXML...', false);
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
            
            if(xmlDoc.querySelector("parsererror")) {
                throw new Error("Invalid XML file");
            }
            
            currentNotes = parseMusicXML(xmlDoc);
            
            if (currentNotes.length > 0) {
                renderPartControls(availableParts);
                
                updateStatus(`Ready to play: ${currentNotes.length} notes across ${availableParts.length} parts.`, false);
                playBtn.disabled = false;
                exportBtn.disabled = false;
                
                let defaultTempoNode = xmlDoc.querySelector('sound[tempo]');
                if (defaultTempoNode) {
                    let xmlTempo = Math.round(parseFloat(defaultTempoNode.getAttribute('tempo')));
                    xmlTempo = Math.max(50, Math.min(170, xmlTempo));
                    bpmSlider.value = xmlTempo;
                    bpmVal.textContent = xmlTempo;
                    if (window.Tone && Tone.Transport) {
                        Tone.Transport.bpm.value = xmlTempo;
                    }
                }
            } else {
                updateStatus("No notes found in the file.", true);
                playBtn.disabled = true;
                exportBtn.disabled = true;
            }
        } catch (error) {
            console.error(error);
            updateStatus('Error parsing file.', true);
        }
    };
    reader.readAsText(file);
}

function hasWords(measure, matchStr) {
    const wordsNodes = measure.querySelectorAll('direction direction-type words');
    for (let node of wordsNodes) {
        if (node.textContent.toLowerCase().includes(matchStr.toLowerCase())) return true;
    }
    return false;
}

function buildMeasureRoadmap(part) {
    const measures = Array.from(part.querySelectorAll('measure'));
    const markers = { segno: -1, coda: -1 };
    
    measures.forEach((measure, i) => {
        let sound = measure.querySelector('sound');
        if (sound) {
             if (sound.hasAttribute('segno')) markers.segno = i;
             if (sound.hasAttribute('coda')) markers.coda = i;
        }
        if (measure.querySelector('direction-type segno')) markers.segno = i;
        if (measure.querySelector('direction-type coda')) markers.coda = i;
    });

    const unrolledIndices = [];
    let i = 0;
    let playCounts = {}; 
    let hasJumped = false; 
    let lastForwardRepeat = 0;
    let maxIterations = 10000;
    
    while (i < measures.length && maxIterations > 0) {
        maxIterations--;
        const measure = measures[i];
        let skipMeasure = false;
        
        let currentPass = (playCounts[lastForwardRepeat] || 0) + 1;
        
        const ending = measure.querySelector('ending[type="start"]');
        if (ending) {
            let numbers = ending.getAttribute('number');
            if (numbers) {
                let validPasses = numbers.split(',').map(n => parseInt(n.trim()));
                if (!validPasses.includes(currentPass)) {
                    skipMeasure = true;
                }
            }
        }
        
        if (!skipMeasure) {
            unrolledIndices.push(i);
            const sound = measure.querySelector('sound');
            
            let isFine = (sound && sound.getAttribute('fine') === "yes") || hasWords(measure, "fine");
            if (isFine && hasJumped) break;
            
            let isToCoda = (sound && sound.hasAttribute('tocoda')) || hasWords(measure, "to coda");
            if (isToCoda && hasJumped && markers.coda !== -1) {
                i = markers.coda;
                continue; 
            }
            
            const fwdRepeat = measure.querySelector('repeat[direction="forward"]');
            if (fwdRepeat) {
                lastForwardRepeat = i;
                playCounts[lastForwardRepeat] = playCounts[lastForwardRepeat] || 0;
            }
            
            const bwdRepeat = measure.querySelector('repeat[direction="backward"]');
            if (bwdRepeat) {
                let times = bwdRepeat.getAttribute('times');
                let targetCount = times ? parseInt(times) : 2; 
                let currentPasses = playCounts[lastForwardRepeat] || 0;
                
                if (currentPasses < targetCount - 1) {
                    playCounts[lastForwardRepeat] = currentPasses + 1;
                    i = lastForwardRepeat;
                    continue;
                }
            }
            
            if (!hasJumped) {
                let isDacapo = (sound && sound.getAttribute('dacapo') === "yes") || hasWords(measure, "d.c.");
                if (isDacapo) {
                    hasJumped = true;
                    i = 0;
                    continue;
                } 
                
                let isDalsegno = (sound && sound.hasAttribute('dalsegno')) || hasWords(measure, "d.s.");
                if (isDalsegno && markers.segno !== -1) {
                    hasJumped = true;
                    i = markers.segno;
                    continue;
                }
            }
        }
        i++;
    }
    return unrolledIndices;
}

function parseMusicXML(xmlDoc) {
    let notes = [];
    let currentTimeQN = 0;
    maxTimeQN = 0;
    
    // Resolve available parts from score structure manually
    availableParts = [];
    const partList = xmlDoc.querySelector('part-list');
    if (partList) {
        Array.from(partList.querySelectorAll('score-part')).forEach(sp => {
            const id = sp.getAttribute('id');
            const nameNode = sp.querySelector('part-name');
            const name = nameNode ? nameNode.textContent : `Part ${id}`;
            availableParts.push({ id, name });
        });
    }
    
    const parts = Array.from(xmlDoc.querySelectorAll('part'));
    if (!parts.length) return [];
    
    // If part-list didn't yield anything, dynamically harvest IDs from part nodes instead
    if (availableParts.length === 0) {
        parts.forEach((p, idx) => {
            availableParts.push({ id: p.getAttribute('id') || String(idx), name: `Track ${idx+1}` });
        });
    }
    
    // Process repeating logic roadmap using master piece reference Part 0
    const unrolledIndices = buildMeasureRoadmap(parts[0]);
    
    parts.forEach(part => {
        let partId = part.getAttribute('id');
        currentTimeQN = 0;
        let divisions = 24;
        let previousDurationQN = 0;
        
        const measures = Array.from(part.querySelectorAll('measure'));
        
        unrolledIndices.forEach(idx => {
            if (idx >= measures.length) return;
            const measure = measures[idx];
            
            Array.from(measure.children).forEach(node => {
                if (node.nodeName === 'attributes') {
                    const divNode = node.querySelector('divisions');
                    if (divNode) divisions = parseInt(divNode.textContent);
                } else if (node.nodeName === 'note') {
                    const durationNode = node.querySelector('duration');
                    const durationUnits = durationNode ? parseInt(durationNode.textContent) : 0;
                    const durationQN = durationUnits / divisions;
                    
                    const isChord = node.querySelector('chord') !== null;
                    const isRest = node.querySelector('rest') !== null;
                    
                    let noteStartTimeQN = currentTimeQN;
                    if (isChord) noteStartTimeQN -= previousDurationQN;
                    
                    if (!isRest && durationQN > 0) {
                        const pitchNode = node.querySelector('pitch');
                        if (pitchNode) {
                            const step = pitchNode.querySelector('step').textContent;
                            const octave = pitchNode.querySelector('octave').textContent;
                            const alterNode = pitchNode.querySelector('alter');
                            const alter = alterNode ? parseInt(alterNode.textContent) : 0;
                            
                            let noteName = step;
                            if (alter === 1) noteName += '#';
                            if (alter === -1) noteName += 'b';
                            noteName += octave;
                            
                            notes.push({
                                pitch: noteName,
                                startQN: noteStartTimeQN,
                                durationQN: durationQN,
                                partId: partId // Map note strictly to its track pipeline
                            });
                            
                            if (noteStartTimeQN + durationQN > maxTimeQN) {
                                maxTimeQN = noteStartTimeQN + durationQN;
                            }
                        }
                    }
                    
                    if (!isChord) {
                        currentTimeQN += durationQN;
                        previousDurationQN = durationQN;
                    }
                } else if (node.nodeName === 'backup') {
                    const durNode = node.querySelector('duration');
                    if (durNode) currentTimeQN -= parseInt(durNode.textContent) / divisions;
                } else if (node.nodeName === 'forward') {
                    const durNode = node.querySelector('duration');
                    if (durNode) currentTimeQN += parseInt(durNode.textContent) / divisions;
                }
            });
        });
    });
    
    notes.sort((a,b) => a.startQN - b.startQN);
    return notes;
}

async function prepareAudio() {
    if (!ac) {
        await Tone.start();
        ac = Tone.context.rawContext;
        
        masterGain = ac.createGain();
        masterGain.connect(ac.destination);
    }
    
    const selects = Array.from(document.querySelectorAll('.part-instrument-select'));
    if (selects.length === 0) return;
    
    if (selects.some(s => !s.value)) {
        updateStatus('Please assign an instrument to all parts before playing.', true);
        throw new Error("Unassigned instruments");
    }
    
    updateStatus('Verifying instrument samples...', false);
    
    let pendingLoads = [];
    selects.forEach(select => {
        const id = select.dataset.partId;
        const val = select.value;
        const sfName = val.includes('recorder') ? 'recorder' : val;
        
        if (!sfInstruments[id]) {
            if (sfName === 'recorder') {
                sfInstruments[id] = new CustomRecorderSampler(ac, { destination: masterGain });
            } else {
                sfInstruments[id] = new Soundfont(ac, {
                    instrument: sfName,
                    destination: masterGain
                });
            }
            pendingLoads.push(sfInstruments[id].load);
        }
    });
    
    if (pendingLoads.length > 0) {
        updateStatus('Downloading high-quality orchestration buffers...', false);
        try {
            await Promise.all(pendingLoads);
            updateStatus('All instruments loaded successfully.', false);
        } catch (err) {
            console.error("Instrument Initialization:", err);
            updateStatus('Error downloading instrument samples.', true);
            throw err;
        }
    } else {
        updateStatus('Ready.', false);
    }
}

function triggerVisualizer() {
    bars.forEach(bar => {
        if(Math.random() > 0.5) {
            bar.style.height = `${20 + Math.random() * 40}px`;
            bar.classList.add('active');
            setTimeout(() => {
                bar.style.height = '10px';
                bar.classList.remove('active');
            }, 100);
        }
    });
}

function stopPlaying(aborted = false) {
    Tone.Transport.stop();
    Tone.Transport.cancel(); 
    
    Object.values(sfInstruments).forEach(sf => {
        if (sf) sf.stop();
    });
    isPlaying = false;
    
    playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    stopBtn.disabled = true;
    
    if (isRecording && aborted) {
        isRecording = false;
        exportBtn.disabled = false;
        playBtn.disabled = false;
        updateStatus('Export aborted automatically.', true);
    } else {
        updateStatus('Stopped.');
    }
    
    bars.forEach(bar => {
        bar.style.height = '10px';
        bar.classList.remove('active');
    });
}

function triggerMasterPlayback() {
    Tone.Transport.cancel();
    Tone.Transport.bpm.value = parseFloat(bpmSlider.value);
    
    let transpositions = {};
    const transposeChks = Array.from(document.querySelectorAll('.transpose-chk'));
    transposeChks.forEach(chk => {
        let partId = chk.dataset.partId;
        let shift = 0;
        if (chk.checked) {
            let valInput = document.querySelector(`.transpose-val[data-part-id="${partId}"]`);
            if (valInput) shift = parseInt(valInput.value) || 0;
        }
        transpositions[partId] = shift;
    });
    
    currentNotes.forEach(note => {
        let startTick = note.startQN * Tone.Transport.PPQ;
        Tone.Transport.schedule((time) => {
            let shift = transpositions[note.partId] || 0;
            let midiNode = Tone.Frequency(note.pitch).toMidi() + shift;
            let durSec = Tone.Ticks(note.durationQN * Tone.Transport.PPQ).toSeconds();
            
            // Map the scheduling stream explicitly to whichever sample set corresponds natively to its part string identifier
            let isExcluded = false;
            if (isRecording) {
                const chk = document.querySelector(`.exclude-export-chk[data-part-id="${note.partId}"]`);
                if (chk && chk.checked) isExcluded = true;
            }
            
            if (!isExcluded) {
                let sf = sfInstruments[note.partId];
                if (sf) {
                    sf.start({ note: midiNode, time: time, duration: durSec });
                }
            }
            triggerVisualizer();
        }, Math.round(startTick) + "i");
    });
    
    let endTick = maxTimeQN * Tone.Transport.PPQ;
    Tone.Transport.schedule((time) => { 
        if (isRecording) {
            setTimeout(finishMediaExport, 2000); 
        } else {
            stopPlaying(); 
        }
    }, Math.round(endTick) + "i");
    
    Tone.Transport.start();
}

playBtn.addEventListener('click', async () => {
    if (isPlaying) {
        Tone.Transport.pause();
        Object.values(sfInstruments).forEach(sf => { if (sf) sf.stop(); });
        isPlaying = false;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        updateStatus('Paused.');
        return;
    }
    try {
        await prepareAudio();
        
        if (Tone.Transport.state !== 'paused') {
            triggerMasterPlayback();
        } else {
            Tone.Transport.start();
        }
        
        isPlaying = true;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        stopBtn.disabled = false;
        updateStatus('Playing...');
    } catch(e) {
        console.error(e);
        updateStatus('Could not play audio due to an error.', true);
    }
});

stopBtn.addEventListener('click', () => stopPlaying(true));


// =========== NATIVE MEDIA RECORDER TO WAV Exporter ===========

let isRecording = false;
let activeMediaRecorder = null;
let activeStreamNode = null;
let mediaChunks = [];

function arraysToWav(buffer, sampleRate) {
    let left = buffer.getChannelData(0);
    let right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

    let numOfChan = 2;
    let length = left.length * numOfChan * 2 + 44;
    let outBuf = new ArrayBuffer(length);
    let view = new DataView(outBuf);
    let pos = 0;

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); 
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16); 
    setUint16(1); // PCM
    setUint16(numOfChan);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numOfChan); 
    setUint16(numOfChan * 2); 
    setUint16(16); // 16-bit
    setUint32(0x61746164); // "data" 
    setUint32(length - pos - 4); 

    let offset = 0;
    while (pos < length) {
        let sampleL = Math.max(-1, Math.min(1, left[offset]));
        sampleL = (0.5 + sampleL < 0 ? sampleL * 32768 : sampleL * 32767) | 0;
        view.setInt16(pos, sampleL, true);
        pos += 2;
        
        let sampleR = Math.max(-1, Math.min(1, right[offset]));
        sampleR = (0.5 + sampleR < 0 ? sampleR * 32768 : sampleR * 32767) | 0;
        view.setInt16(pos, sampleR, true);
        pos += 2;
        
        offset++;
    }

    return new Blob([outBuf], { type: "audio/wav" });
}

exportBtn.addEventListener('click', async () => {
    if (!currentNotes.length) return;
    try {
        await prepareAudio();
        stopPlaying(false);
        
        updateStatus('Exporting... Audio will play natively to correctly lock the timeline.', false);
        exportBtn.disabled = true;
        playBtn.disabled = true;
        
        isRecording = true;
        mediaChunks = [];
        
        activeStreamNode = ac.createMediaStreamDestination();
        masterGain.connect(activeStreamNode);
        
        activeMediaRecorder = new MediaRecorder(activeStreamNode.stream);
        activeMediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) mediaChunks.push(e.data);
        };
        activeMediaRecorder.start();
        
        triggerMasterPlayback();
        isPlaying = true;
        stopBtn.disabled = false;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } catch (e) {
        console.error("Export Launch Error:", e);
        updateStatus('Export failed to launch.', true);
        exportBtn.disabled = false;
        playBtn.disabled = false;
    }
});

function finishMediaExport() {
    isRecording = false;
    stopPlaying(false);
    updateStatus('Processing audio decode into WAV chunk...', false);
    
    if (activeMediaRecorder) {
        activeMediaRecorder.onstop = async () => {
            masterGain.disconnect(activeStreamNode);
            activeStreamNode = null;
            
            try {
                const combinedBlob = new Blob(mediaChunks);
                const arrayBuffer = await combinedBlob.arrayBuffer();
                const audioBuffer = await ac.decodeAudioData(arrayBuffer);
                
                let wavBlob = arraysToWav(audioBuffer, audioBuffer.sampleRate);
                
                const url = URL.createObjectURL(wavBlob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                let safeName = fileNameDisplay.textContent.replace('.musicxml', '').replace('.xml', '');
                let bpm = parseFloat(bpmSlider.value);
                a.download = `${safeName}_${bpm}bpm.wav`;
                document.body.appendChild(a);
                a.click();
                
                setTimeout(() => { 
                    document.body.removeChild(a); 
                    window.URL.revokeObjectURL(url); 
                }, 1000);
                
                exportBtn.disabled = false;
                playBtn.disabled = false;
                updateStatus('WAV Exported and Downloaded Successfully!', false);
            } catch (err) {
                console.error(err);
                updateStatus('Export conversion failed.', true);
                exportBtn.disabled = false;
                playBtn.disabled = false;
            }
        };
        activeMediaRecorder.stop();
    }
}

function updateStatus(msg, isError = false) {
    statusBar.textContent = msg;
    statusBar.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
}
