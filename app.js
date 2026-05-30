import { Soundfont } from "https://cdn.jsdelivr.net/npm/smplr/dist/index.mjs";

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
const isolateChk = document.getElementById('isolate-measures-chk');
const isolateInput = document.getElementById('isolate-measures-input');
const loopChk = document.getElementById('loop-chk');

let currentNotes = [];
let availableParts = [];
let sfInstruments = {}; // Maps part.id to an instrument instance
let globalInstrumentCache = {}; // Caches instrument instances by their selected dropdown value
let globalRecorderSamples = null;
let globalRecorderPromise = null;
let ac = null;
let masterGain = null;
let isPlaying = false;
let maxTimeQN = 0;
let globalXmlDoc = null;
let rawXmlContent = '';

class CustomRecorderSampler {
    constructor(ac, options) {
        this.ac = ac;
        this.destination = options.destination;
        this.type = options.type;
        this.samples = {};
        this.activeSources = [];
        this.load = this._loadInternal();
    }

    async _loadInternal() {
        if (globalRecorderSamples) {
            this.samples = globalRecorderSamples;
            return;
        }
        
        if (!globalRecorderPromise) {
            globalRecorderPromise = (async () => {
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
                    return null;
                }

                const targetNotes = {
                    60: "C4",
                    72: "C5",
                    84: "C6",
                    96: "C7"
                };
                
                let decodedSamples = {};
                for (const midi in targetNotes) {
                    const noteName = targetNotes[midi];
                    if (allSamples[noteName]) {
                        const base64 = allSamples[noteName].split(",")[1];
                        const arrayBuffer = this._base64ToArrayBuffer(base64);
                        const audioBuffer = await this.ac.decodeAudioData(arrayBuffer);
                        decodedSamples[midi] = audioBuffer;
                    }
                }
                return decodedSamples;
            })();
        }
        
        this.samples = await globalRecorderPromise;
        if (this.samples) {
            globalRecorderSamples = this.samples;
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
        let shiftedNote = note;
        if (this.type === 'soprano-recorder') shiftedNote += 12;
        else if (this.type === 'alto-recorder') shiftedNote += 7;
        else if (this.type === 'tenor-recorder') shiftedNote += 0;
        else if (this.type === 'bass-recorder') shiftedNote -= 12;

        let nearestMidi = null;
        let minDiff = Infinity;
        for (const midiStr in this.samples) {
            const m = parseInt(midiStr);
            const diff = Math.abs(shiftedNote - m);
            if (diff < minDiff) {
                minDiff = diff;
                nearestMidi = m;
            }
        }

        if (!nearestMidi) return;

        const diffSemis = shiftedNote - nearestMidi;
        
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
        
        const sourceObj = { source, gainNode };
        this.activeSources.push(sourceObj);
        
        source.onended = () => {
            try { source.disconnect(); } catch(e){}
            try { gainNode.disconnect(); } catch(e){}
            const idx = this.activeSources.indexOf(sourceObj);
            if (idx > -1) {
                this.activeSources.splice(idx, 1);
            }
        };
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

class CustomSynthCello {
    constructor(ac, options) {
        this.ac = ac;
        this.destination = options.destination;
        
        this.filter = new Tone.Filter(1800, "lowpass").connect(this.destination);
        this.synth = new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 3.01,
            modulationIndex: 14,
            oscillator: { type: "triangle" },
            envelope: { attack: 0.15, decay: 0.2, sustain: 0.85, release: 0.8 },
            modulation: { type: "square" },
            modulationEnvelope: { attack: 0.15, decay: 0.2, sustain: 0.85, release: 0.8 }
        }).connect(this.filter);
        this.synth.volume.value = -4;
        this.load = Promise.resolve();
    }
    start({ note, time, duration }) {
        try {
            const transposed = Tone.Frequency(note, "midi").toNote();
            this.synth.triggerAttackRelease(transposed, duration, time);
        } catch(e){}
    }
    stop() {
        try { this.synth.releaseAll(); } catch(e){}
    }
}

class CustomHarpsichord {
    constructor(ac, options) {
        this.ac = ac;
        this.destination = options.destination;
        
        // Add realistic acoustic properties to the dry Soundfont
        this.eq = new Tone.EQ3({ low: 1, mid: -3, high: 6 }); // Boost highs for the 'pluck'
        this.chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 2.5, depth: 0.15, spread: 90 }).start(); // String width
        this.reverb = new Tone.Freeverb({ roomSize: 0.65, dampening: 4500 }); // Chamber acoustic reflection
        this.reverb.wet.value = 0.25;
        
        this.rawInput = ac.createGain();
        Tone.connect(this.rawInput, this.eq);
        this.eq.chain(this.chorus, this.reverb);
        Tone.connect(this.reverb, this.destination);

        this.sf = new Soundfont(ac, {
            instrument: "harpsichord",
            destination: this.rawInput
        });
        
        this.load = this.sf.load;
    }
    
    start(opts) {
        this.sf.start(opts);
    }
    
    stop() {
        this.sf.stop();
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

if (loopChk) {
    loopChk.addEventListener('change', (e) => {
        if (window.Tone && Tone.Transport) {
            Tone.Transport.loop = e.target.checked;
        }
    });
}

if (isolateChk) {
    isolateChk.addEventListener('change', () => {
        isolateInput.disabled = !isolateChk.checked;
        if (globalXmlDoc) {
            currentNotes = parseMusicXML(globalXmlDoc);
            updateStatus(`Ready to play: ${currentNotes.length} notes across ${availableParts.length} parts.`, false);
        }
    });
}

if (isolateInput) {
    isolateInput.addEventListener('input', () => {
        if (isolateChk.checked && globalXmlDoc) {
            currentNotes = parseMusicXML(globalXmlDoc);
            updateStatus(`Ready to play: ${currentNotes.length} notes across ${availableParts.length} parts.`, false);
        }
    });
}

dropZone.addEventListener('click', (e) => {
    if (e.target === fileInput) return;
    fileInput.value = '';
    fileInput.click();
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

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
                <option value="synth_cello">Cello</option>
            </optgroup>
        `;
        
        select.addEventListener('change', () => {
            // Now handled by global caching, no need to delete here
            // Update ui/state logic if necessary
        });
        
        const excludeLabel = document.createElement('label');
        excludeLabel.style.cssText = "display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-muted); font-size: 0.85rem; padding-left: 4px; white-space: nowrap;";
        
        const excludeCheck = document.createElement('input');
        excludeCheck.type = 'checkbox';
        excludeCheck.className = 'exclude-export-chk';
        excludeCheck.dataset.partId = part.id;
        
        excludeLabel.appendChild(excludeCheck);
        excludeLabel.appendChild(document.createTextNode('Exclude'));
        
        
        const row = document.createElement('div');
        row.style.cssText = "display: flex; align-items: center; gap: 12px;";
        
        selectWrapper.style.flex = "1";
        selectWrapper.appendChild(select);
        
        row.appendChild(selectWrapper);
        row.appendChild(excludeLabel);
        
        group.appendChild(label);
        group.appendChild(row);
        partsContainer.appendChild(group);
    });
}

function handleFile(file) {
    if (isPlaying) stopPlaying(false);

    const name = file.name.toLowerCase();
    if (!name.endsWith('.xml') && !name.endsWith('.musicxml') && !name.endsWith('.mxl')) {
        updateStatus('Please upload a valid .xml, .musicxml, or .mxl file.', true);
        return;
    }
    
    fileNameDisplay.style.display = 'inline-block';
    fileNameDisplay.textContent = file.name;
    updateStatus('Parsing MusicXML...', false);
    
    if (name.endsWith('.mxl')) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                if (typeof JSZip === 'undefined') {
                    throw new Error("JSZip library is not loaded.");
                }
                const zip = await JSZip.loadAsync(e.target.result);
                
                // .mxl files specify the main score file in META-INF/container.xml
                let xmlContent = null;
                const filePaths = Object.keys(zip.files);
                const containerPath = filePaths.find(p => p.toLowerCase() === "meta-inf/container.xml");
                
                if (containerPath) {
                    const containerXml = await zip.file(containerPath).async("string");
                    const containerDoc = new DOMParser().parseFromString(containerXml, "text/xml");
                    const rootfile = containerDoc.querySelector("rootfile");
                    if (rootfile) {
                        const fullPath = rootfile.getAttribute("full-path");
                        // fullPath inside container might not exactly match case in zip.files
                        const scorePath = filePaths.find(p => p === fullPath || p.toLowerCase() === fullPath.toLowerCase());
                        if (scorePath) {
                            xmlContent = await zip.file(scorePath).async("string");
                        }
                    }
                }
                
                // Fallback if container.xml is missing or malformed: find the first .xml file
                if (!xmlContent) {
                    for (const relativePath of filePaths) {
                        if (relativePath.toLowerCase().endsWith('.xml') && !relativePath.toLowerCase().startsWith('meta-inf/')) {
                            xmlContent = await zip.files[relativePath].async('string');
                            break;
                        }
                    }
                }
                
                if (!xmlContent) {
                    throw new Error("Could not find an XML file inside the MXL archive.");
                }
                
                parseXmlString(xmlContent);
            } catch (error) {
                console.error(error);
                updateStatus('Error parsing MXL file. Is it a valid zipped MusicXML?', true);
            }
        };
        reader.readAsArrayBuffer(file);
    } else {
        const reader = new FileReader();
        reader.onload = (e) => {
            parseXmlString(e.target.result);
        };
        reader.readAsText(file);
    }
}

function parseXmlString(xmlString) {
    rawXmlContent = xmlString;
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlString, "text/xml");
        
        if(xmlDoc.querySelector("parsererror")) {
            throw new Error("Invalid XML file");
        }
        
        globalXmlDoc = xmlDoc;
        currentNotes = parseMusicXML(xmlDoc);
        
        if (currentNotes.length > 0) {
            renderPartControls(availableParts);
            
            updateStatus(`Ready to play: ${currentNotes.length} notes across ${availableParts.length} parts.`, false);
            playBtn.disabled = false;
            exportBtn.disabled = false;
            document.getElementById('create-share-btn').disabled = false;
            document.getElementById('download-xml-btn').disabled = false;
            
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
            document.getElementById('create-share-btn').disabled = true;
            document.getElementById('download-xml-btn').disabled = true;
        }
    } catch (error) {
        console.error(error);
        updateStatus('Error parsing file.', true);
    }
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

function getIsolatedIndices(inputText, totalMeasures) {
    let indices = [];
    const segments = inputText.split(',');
    for (let segment of segments) {
        segment = segment.trim();
        if (!segment) continue;
        if (segment.includes('-')) {
            const parts = segment.split('-');
            const start = parseInt(parts[0].trim());
            const end = parseInt(parts[1].trim());
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) {
                    if (i >= 1 && i <= totalMeasures) indices.push(i - 1);
                }
            }
        } else {
            const num = parseInt(segment);
            if (!isNaN(num) && num >= 1 && num <= totalMeasures) {
                indices.push(num - 1);
            }
        }
    }
    return indices.sort((a,b) => a - b);
}

function parseMusicXML(xmlDoc) {
    let notes = [];
    let currentTimeQN = 0;
    maxTimeQN = 0;
    
    let baseNames = {};
    const partList = xmlDoc.querySelector('part-list');
    if (partList) {
        Array.from(partList.querySelectorAll('score-part')).forEach(sp => {
            const id = sp.getAttribute('id');
            const nameNode = sp.querySelector('part-name');
            baseNames[id] = nameNode ? nameNode.textContent : `Part ${id}`;
        });
    }
    
    const parts = Array.from(xmlDoc.querySelectorAll('part'));
    if (!parts.length) return [];
    
    let discoveredPartsMap = new Map();
    
    // Process repeating logic roadmap using master piece reference Part 0
    let unrolledIndices = [];
    const totalMeasures = parts[0].querySelectorAll('measure').length;
    if (isolateChk && isolateChk.checked && isolateInput && isolateInput.value.trim() !== '') {
        unrolledIndices = getIsolatedIndices(isolateInput.value, totalMeasures);
    } else {
        unrolledIndices = buildMeasureRoadmap(parts[0]);
    }
    
    parts.forEach((part, partIndex) => {
        let partId = part.getAttribute('id');
        let baseName = baseNames[partId] || `Track ${partIndex + 1}`;
        let friendlyName = parts.length > 1 ? `${baseName} (Line ${partIndex + 1})` : baseName;
        currentTimeQN = 0;
        let divisions = 24;
        let previousDurationQN = 0;
        
        const measures = Array.from(part.querySelectorAll('measure'));
        
        if (unrolledIndices.length > 0) {
            let firstMeasureIdx = unrolledIndices[0];
            for (let i = 0; i < firstMeasureIdx; i++) {
                if (i >= measures.length) break;
                const measure = measures[i];
                Array.from(measure.children).forEach(node => {
                    if (node.nodeName === 'attributes') {
                        const divNode = node.querySelector('divisions');
                        if (divNode) divisions = parseInt(divNode.textContent);
                    }
                });
            }
        }
        
        unrolledIndices.forEach(idx => {
            if (idx >= measures.length) return;
            const measure = measures[idx];
            let measureMaxTimeQN = currentTimeQN;
            
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
                            
                            const staffNode = node.querySelector('staff');
                            const staffId = staffNode ? staffNode.textContent : '1';
                            
                            let isKeyboard = /piano|harpsichord|keyboard|organ|cembalo/i.test(friendlyName);
                            let effectivePartId = `track_${partIndex}`;
                            if (!isKeyboard) {
                                effectivePartId += `_S${staffId}`;
                            }
                            
                            if (!discoveredPartsMap.has(effectivePartId)) {
                                discoveredPartsMap.set(effectivePartId, { 
                                    id: effectivePartId, 
                                    baseName: friendlyName, 
                                    staffId: isKeyboard ? '1' : staffId 
                                });
                            }
                            
                            notes.push({
                                pitch: noteName,
                                startQN: noteStartTimeQN,
                                durationQN: durationQN,
                                partId: effectivePartId
                            });
                            
                            if (noteStartTimeQN + durationQN > maxTimeQN) {
                                maxTimeQN = noteStartTimeQN + durationQN;
                            }
                        }
                    }
                    
                    if (!isChord) {
                        currentTimeQN += durationQN;
                        previousDurationQN = durationQN;
                        if (currentTimeQN > measureMaxTimeQN) {
                            measureMaxTimeQN = currentTimeQN;
                        }
                    }
                } else if (node.nodeName === 'backup') {
                    const durNode = node.querySelector('duration');
                    if (durNode) currentTimeQN -= parseInt(durNode.textContent) / divisions;
                } else if (node.nodeName === 'forward') {
                    const durNode = node.querySelector('duration');
                    if (durNode) {
                        currentTimeQN += parseInt(durNode.textContent) / divisions;
                        if (currentTimeQN > measureMaxTimeQN) {
                            measureMaxTimeQN = currentTimeQN;
                        }
                    }
                }
            });
            currentTimeQN = measureMaxTimeQN;
        });
    });
    
    availableParts = Array.from(discoveredPartsMap.values());
    
    let partCounts = {};
    availableParts.forEach(p => {
        let base = p.id.split('_S')[0]; // track_0
        partCounts[base] = (partCounts[base] || 0) + 1;
    });
    
    availableParts.forEach(p => {
        let base = p.id.split('_S')[0];
        if (partCounts[base] > 1) {
            p.name = `${p.baseName} (Staff ${p.staffId})`;
        } else {
            p.name = p.baseName;
        }
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
        alert("Please assign an instrument to all parts before playing.");
        updateStatus('Please assign an instrument to all parts before playing.', true);
        throw new Error("Unassigned instruments");
    }
    
    updateStatus('Verifying instrument samples...', false);
    
    let pendingLoads = [];
    selects.forEach(select => {
        const id = select.dataset.partId;
        const val = select.value;
        const sfName = val.includes('recorder') ? 'recorder' : val;
        
        if (!globalInstrumentCache[val]) {
            if (val === 'synth_cello') {
                globalInstrumentCache[val] = new CustomSynthCello(ac, { destination: masterGain });
            } else if (val === 'harpsichord') {
                globalInstrumentCache[val] = new CustomHarpsichord(ac, { destination: masterGain });
            } else if (sfName === 'recorder') {
                globalInstrumentCache[val] = new CustomRecorderSampler(ac, { destination: masterGain, type: val });
            } else {
                globalInstrumentCache[val] = new Soundfont(ac, {
                    instrument: sfName,
                    destination: masterGain
                });
            }
            pendingLoads.push(globalInstrumentCache[val].load);
        }
        
        // Link the part directly to the cached instrument instance
        sfInstruments[id] = globalInstrumentCache[val];
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

let lastVisTime = 0;
function triggerVisualizer() {
    let now = performance.now();
    if (now - lastVisTime < 30) return; // Throttle to prevent DOM thrashing
    lastVisTime = now;
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
    
    const countInBeats = 4;
    const countInTicks = countInBeats * Tone.Transport.PPQ;
    const pauseTicks = Math.round((parseFloat(bpmSlider.value) / 60) * Tone.Transport.PPQ);
    
    if (!window.woodblockSynth) {
        window.woodblockSynth = new Tone.MembraneSynth({
            pitchDecay: 0.01,
            octaves: 1.5,
            oscillator: { type: "sine" },
            envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.01 }
        }).connect(masterGain);
        window.woodblockSynth.volume.value = -6;
    }

    for (let i = 0; i < countInBeats; i++) {
        let tick = i * Tone.Transport.PPQ;
        Tone.Transport.schedule((time) => {
            window.woodblockSynth.triggerAttackRelease(i === 0 ? "A5" : "E5", "16n", time, 1);
            Tone.Draw.schedule(() => {
                triggerVisualizer();
            }, time);
        }, Math.round(tick) + "i");
    }
    
    if (loopChk) {
        Tone.Transport.loop = isRecording ? false : loopChk.checked;
        Tone.Transport.loopStart = Math.round(countInTicks) + "i";
        Tone.Transport.loopEnd = Math.round(maxTimeQN * Tone.Transport.PPQ + countInTicks + pauseTicks) + "i";
    }
    // Pre-cache excluded parts to prevent inline DOM querying on the audio thread
    const excludedParts = new Set();
    document.querySelectorAll('.exclude-export-chk').forEach(chk => {
        if (chk.checked) excludedParts.add(chk.dataset.partId);
    });
    
    let scheduledDrawTimes = new Set();
    
    currentNotes.forEach(note => {
        let startTick = (note.startQN * Tone.Transport.PPQ) + countInTicks;
        let midiNode = Tone.Frequency(note.pitch).toMidi();
        
        Tone.Transport.schedule((time) => {
            if (excludedParts.has(note.partId)) return; // Skip excluded parts
            
            let durSec = Tone.Ticks(note.durationQN * Tone.Transport.PPQ).toSeconds();
            
            let sf = sfInstruments[note.partId];
            if (sf) {
                sf.start({ note: midiNode, time: time, duration: durSec });
            }
        }, Math.round(startTick) + "i");
        
        let timeKey = Math.round(startTick);
        if (!scheduledDrawTimes.has(timeKey)) {
            scheduledDrawTimes.add(timeKey);
            Tone.Transport.schedule((time) => {
                Tone.Draw.schedule(() => {
                    triggerVisualizer();
                }, time);
            }, timeKey + "i");
        }
    });
    
    let endTick = maxTimeQN * Tone.Transport.PPQ + countInTicks + pauseTicks;
    Tone.Transport.schedule((time) => {
        if (isRecording) {
            setTimeout(finishMediaExport, 2000); 
        } else {
            if (!Tone.Transport.loop) {
                stopPlaying(); 
            }
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
        if (e.message !== "Unassigned instruments") {
            updateStatus('Could not play audio due to an error.', true);
        }
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
        if (e.message !== "Unassigned instruments") {
            updateStatus('Export failed to launch.', true);
        }
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

// Sharing and Downloading logic
document.getElementById('download-xml-btn').addEventListener('click', () => {
    if (!rawXmlContent) return;
    const blob = new Blob([rawXmlContent], {type: "text/xml"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "music.xml";
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('create-share-btn').addEventListener('click', async () => {
    const selects = Array.from(document.querySelectorAll('.part-instrument-select'));
    const instruments = selects.map(s => ({ id: s.dataset.partId, val: s.value }));
    const excludes = Array.from(document.querySelectorAll('.exclude-export-chk')).map(c => ({ id: c.dataset.partId, checked: c.checked }));
    const state = {
        xml: rawXmlContent,
        instruments: instruments,
        excludes: excludes,
        bpm: bpmSlider.value,
        loop: loopChk ? loopChk.checked : false,
        isolate: isolateChk ? isolateChk.checked : false,
        isolateText: isolateInput ? isolateInput.value : ''
    };
    
    const zip = new JSZip();
    zip.file("state.json", JSON.stringify(state));
    const content = await zip.generateAsync({type:"base64", compression: "DEFLATE"});
    
    const url = new URL(window.location.href);
    url.searchParams.set('share', content);
    
    const shareLinkInput = document.getElementById('share-link-input');
    shareLinkInput.value = url.toString();
    shareLinkInput.style.display = 'block';
    document.getElementById('copy-share-btn').style.display = 'block';
});

document.getElementById('copy-share-btn').addEventListener('click', async () => {
    const shareLinkInput = document.getElementById('share-link-input');
    try {
        await navigator.clipboard.writeText(shareLinkInput.value);
        const originalText = document.getElementById('copy-share-btn').textContent;
        document.getElementById('copy-share-btn').textContent = 'Copied!';
        setTimeout(() => {
            document.getElementById('copy-share-btn').textContent = originalText;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
        alert('Failed to copy link to clipboard');
    }
});

window.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const shareData = urlParams.get('share');
    if (shareData) {
        document.getElementById('password-overlay').style.display = 'flex';
        
        document.getElementById('submit-password-btn').addEventListener('click', async () => {
            const pwd = document.getElementById('share-password-input').value;
            if (pwd === 'PlayAlong') {
                document.getElementById('password-overlay').style.display = 'none';
                await loadSharedState(shareData);
            } else {
                document.getElementById('password-error').style.display = 'block';
            }
        });
    }
});

async function loadSharedState(base64Data) {
    try {
        updateStatus('Loading shared file...', false);
        const zip = await JSZip.loadAsync(base64Data, {base64: true});
        const stateStr = await zip.file("state.json").async("string");
        const state = JSON.parse(stateStr);
        
        // The parsed XML string is stored in state.xml
        // We parse it, which triggers the UI setup
        parseXmlString(state.xml);
        
        // Wait for UI elements to be generated
        setTimeout(() => {
            if (state.instruments) {
                state.instruments.forEach(inst => {
                    const select = document.querySelector(`.part-instrument-select[data-part-id="${inst.id}"]`);
                    if (select) {
                        select.value = inst.val;
                    }
                });
            }
            if (state.excludes) {
                state.excludes.forEach(exc => {
                    const chk = document.querySelector(`.exclude-export-chk[data-part-id="${exc.id}"]`);
                    if (chk) {
                        chk.checked = exc.checked;
                    }
                });
            }
            
            bpmSlider.value = state.bpm;
            bpmVal.textContent = state.bpm;
            if (window.Tone && Tone.Transport) {
                Tone.Transport.bpm.value = state.bpm;
            }
            
            if (loopChk && state.loop !== undefined) loopChk.checked = state.loop;
            if (isolateChk && state.isolate !== undefined) {
                isolateChk.checked = state.isolate;
                isolateInput.disabled = !state.isolate;
            }
            if (isolateInput && state.isolateText !== undefined) isolateInput.value = state.isolateText;
            
            if (isolateChk && isolateChk.checked && globalXmlDoc) {
                currentNotes = parseMusicXML(globalXmlDoc);
                updateStatus(`Ready to play: ${currentNotes.length} notes across ${availableParts.length} parts.`, false);
            }
        }, 200);
        
        fileNameDisplay.style.display = 'inline-block';
        fileNameDisplay.textContent = "Shared Score";
        
    } catch (e) {
        console.error(e);
        updateStatus('Failed to load shared state.', true);
        alert("Failed to load shared state. The link might be broken.");
    }
}
