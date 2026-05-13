/**
 * TTS Persist — Extension v7.9.1 (Smart Header Parser & Unified Group/Persona Clearing)
 * Place folder at: SillyTavern/public/extensions/third-party/tts-persist/
 */

import { saveSettingsDebounced, substituteParams, getRequestHeaders } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';

const EXT = 'tts_persist';
const API = '/api/plugins/tts-persist';

// ── Queue Usurper & Network Traffic Controllers ──────────────────────────────
let queueServingChatId = null;
let globalAbortController = new AbortController();

// ── SillyTavern API Wrapper ──────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    
    if (typeof getRequestHeaders === 'function') {
        const stHeaders = getRequestHeaders();
        for (const [key, value] of Object.entries(stHeaders)) {
            headers.set(key, value);
        }
    }

    options.credentials = 'include'; 
    return fetch(url, { ...options, headers });
}

// ── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
    enabled:           true,
    autoBackground:    true,
    abortOnChatChange: true,
    batchSkipLast:     2, 
    deleteOnEdit:      true,
    keepSwipeAudio:    true,

    collapseOnMobile: true,
    collapseOnPc:     false,

    narrateUserMessages:             false,
    streamManualPlayback:            true,
    chunkBackgroundRequests:         true,
    
    chunkMinLength:                  0,
    chunkSilenceSeconds:             0,

    onlyNarrateQuotes:               false,
    ignoreAsterisksText:             false,
    narrateOnlyTranslated:           false,
    skipCodeblocks:                  true,
    skipTaggedBlocks:                true,
    passAsterisksToTTS:              false,
    differentVoicesForSegments:      false,
    applyRegexFilter:                false,
    regexPattern:                    '',

    audioPlaybackSpeed: 1.0,

    ttsEndpoint:     'http://127.0.0.1:7851/v1/audio/speech',
    ttsApiKey:       'sk-none',
    ttsModel:        'vibevoice/VibeVoice-1.5B',
    ttsVoice:        '',          
    ttsVoiceNarration:'',
    ttsVoiceQuotes:  '',   
    ttsVoiceAsterisks:'',   
    ttsSpeed:        1.0,
    ttsFormat:       'pcm', 
    ttsInstructions: '',
    extraParams:     '{}',

    availableVoices:    '',   
    characterVoices:    {},   
};

function getSettings() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    for (const key of Object.keys(DEFAULTS)) {
        if (extension_settings[EXT][key] === undefined) {
            extension_settings[EXT][key] = DEFAULTS[key];
        }
    }
    return extension_settings[EXT];
}

function saveSettings() { saveSettingsDebounced(); }

// ── Audio Converters & Cleaners ───────────────────────────────────────────────

async function detectFormatClient(blob, requestedFormat) {
    if (blob.size < 4) return requestedFormat;
    const arr = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const sig = (arr[0]<<24) | (arr[1]<<16) | (arr[2]<<8) | arr[3];
    if (sig === 0x52494646) return 'wav';
    if (sig === 0x4f676753) return 'opus';
    if (sig === 0x664c6143) return 'flac';
    if (sig === 0x49443303 || sig === 0x49443304 || (sig & 0xFFE00000) === 0xFFE00000) return 'mp3';
    return requestedFormat;
}

function extractPcmFromWavArrayBuffer(arr) {
    const view = new DataView(arr);
    const uint8 = new Uint8Array(arr);
    try {
        if (uint8.length < 12 || view.getUint32(0, false) !== 0x52494646) return { pcm: uint8.length > 44 ? uint8.slice(44) : uint8, sampleRate: 24000 };
        let offset = 12;
        let sampleRate = 24000;
        while (offset < uint8.length - 8) {
            const chunkId = view.getUint32(offset, false);
            const chunkSize = view.getUint32(offset + 4, true);
            if (chunkId === 0x666d7420) { // 'fmt '
                sampleRate = view.getUint32(offset + 12, true);
            }
            if (chunkId === 0x64617461) { // 'data'
                return { pcm: uint8.slice(offset + 8, offset + 8 + chunkSize), sampleRate };
            }
            offset += 8 + (chunkSize % 2 === 0 ? chunkSize : chunkSize + 1);
        }
    } catch(e) {}
    return { pcm: uint8.length > 44 ? uint8.slice(44) : uint8, sampleRate: 24000 };
}

function cleanMp3Data(uint8Arr) {
    let offset = 0;
    if (uint8Arr.length > 10 && uint8Arr[0] === 0x49 && uint8Arr[1] === 0x44 && uint8Arr[2] === 0x33) {
        const size = (uint8Arr[6] << 21) | (uint8Arr[7] << 14) | (uint8Arr[8] << 7) | uint8Arr[9];
        offset = 10 + size;
    }
    let data = offset > 0 ? uint8Arr.slice(offset) : uint8Arr;
    
    if (data.length >= 128) {
        const end = data.length - 128;
        if (data[end] === 0x54 && data[end+1] === 0x41 && data[end+2] === 0x47) {
            data = data.slice(0, end);
        }
    }
    const scanLimit = Math.min(data.length, 8192);
    for (let i = 0; i < scanLimit - 4; i++) {
        if (
            (data[i] === 0x58 && data[i+1] === 0x69 && data[i+2] === 0x6E && data[i+3] === 0x67) || 
            (data[i] === 0x49 && data[i+1] === 0x6E && data[i+2] === 0x66 && data[i+3] === 0x6F)    
        ) {
            data[i] = 0; data[i+1] = 0; data[i+2] = 0; data[i+3] = 0;
            break;
        }
    }
    return data;
}

async function createWavBlob(pcmDataBlob, { sampleRate, bitDepth, numChannels }) {
    const pcmData = await pcmDataBlob.arrayBuffer();
    const pcmDataSize = pcmData.byteLength;
    const blockAlign = numChannels * (bitDepth / 8);
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44 + pcmDataSize);
    const view = new DataView(buffer);

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    }

    writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + pcmDataSize, true);
    writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); 
    view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true); writeString(view, 36, 'data');
    view.setUint32(40, pcmDataSize, true);

    new Uint8Array(buffer, 44).set(new Uint8Array(pcmData));
    return new Blob([view], { type: 'audio/wav' });
}

// ── Stable ID helpers ─────────────────────────────────────────────────────────

function dateKey(sendDate) {
    return String(sendDate).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 32);
}

function textHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(36);
}

// ── Native 1:1 Text Preprocessing ─────────────────────────────────────────────

function escapeRegex(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function regexFromString(string) {
    const match = /^\/(.*)\/([a-z]*)$/.exec(string);
    if (match) { try { return new RegExp(match[1], match[2]); } catch (e) { return null; } }
    try { return new RegExp(string, 'g'); } catch (e) { return null; }
}

function joinQuotedBlocks(text, opts = {}) {
    const { separator = ' ... ', includeQuotes = true, pairs = [['„', '“'], ['“', '”'], ['«', '»'], ['»', '«'], ['‘', '’'], ['‚', '‘'], ['「', '」'], ['『', '』'], ['"', '"'], ['＂', '＂']] } = opts;
    if (!text || typeof text !== 'string') return text;
    const openToClose = Object.fromEntries(pairs);
    const segments = [], stack = []; 
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const top = stack[stack.length - 1];
        if (top && ch === top.expectedClose) {
            const finished = stack.pop();
            if (stack.length === 0) segments.push(text.slice(finished.start, i + 1));
            continue;
        }
        if (openToClose[ch]) { stack.push({ opener: ch, expectedClose: openToClose[ch], start: i }); continue; }
    }
    if (!segments.length) return text;
    return (includeQuotes ? segments : segments.map(s => s.slice(1, -1))).join(separator);
}

function preprocessText(rawText, msg, charName) {
    const c = getSettings();
    let t = c.narrateOnlyTranslated ? (msg?.extra?.translate || msg?.extra?.display_text || rawText) : rawText;

    if (typeof substituteParams === 'function') t = substituteParams(t);
    
    t = t.replace(/<img[^>]+>/gi, ''); 
    t = t.replace(/!\[.*?]\([^)]*\)/g, ''); 
    t = t.replace(/\[\s*IMG:\s*([^\]]*?)\s*\]/gi, ''); 

    if (c.skipCodeblocks) t = t.replace(/```[\s\S]*?```/gs, '').replace(/~~~[\s\S]*?~~~/gs, '');
    if (c.skipTaggedBlocks) {
        t = t.replace(/<.*?>[\s\S]*?<\/.*?>/g, ''); 
        t = t.replace(/<[^>]+>/g, ''); 
    }
    
    if (!c.passAsterisksToTTS) t = c.ignoreAsterisksText ? t.replace(/\*[^*]*?(\*|$)/g, '') : t.replaceAll('*', '');
    
    if (c.applyRegexFilter && c.regexPattern) {
        const patterns = c.regexPattern.split('\n').filter(p => p.trim());
        for (const p of patterns) {
            const regex = regexFromString(p.trim());
            if (regex) t = t.replace(regex, ' ').trim();
        }
    }
    
    if (c.onlyNarrateQuotes) t = joinQuotedBlocks(t, { separator: ' ... ', includeQuotes: true });

    t = t.replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

    const pu = window.power_user || {};
    if (charName && !pu.allow_name2_display) {
        const escapedChar = escapeRegex(charName);
        t = t.replace(new RegExp(`^${escapedChar}:`, 'gm'), '');
    }

    return t.trim();
}

function parseMessageSegments(text) {
    if (!getSettings().differentVoicesForSegments) return [{ type: 'other', text }];
    const segments = [];
    const segmentRegex = /(\*[^*]*?\*)|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;
    let lastIndex = 0, match;
    segmentRegex.lastIndex = 0;

    while ((match = segmentRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const otherText = text.substring(lastIndex, match.index).trim();
            if (otherText) segments.push({ type: 'other', text: otherText });
        }
        const content = match[0].slice(1, -1).trim();
        if (content) segments.push({ type: match[1] ? 'action' : 'dialogue', text: content });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        const otherText = text.substring(lastIndex).trim();
        if (otherText) segments.push({ type: 'other', text: otherText });
    }
    if (!segments.length && text.trim()) segments.push({ type: 'other', text: text.trim() });
    
    return segments;
}

function smartSplitParagraphs(text, minLength = 0) {
    const lines = text.split('\n').map(p => p.trim()).filter(Boolean);
    if (minLength <= 0) return lines;
    
    const merged = [];
    let current = "";
    
    for (const line of lines) {
        if (!current) {
            current = line;
        } else {
            current += " " + line; 
        }
        
        if (current.length >= minLength) {
            merged.push(current);
            current = "";
        }
    }
    if (current) merged.push(current); 
    return merged;
}

// ── Voice helpers ─────────────────────────────────────────────────────────────
function getVoiceForChar(charName, segmentType = 'other') {
    const c = getSettings();
    let voice = '';
    
    if (c.differentVoicesForSegments) {
        if (segmentType === 'dialogue' && c.ttsVoiceQuotes) voice = c.ttsVoiceQuotes;
        else if (segmentType === 'action' && c.ttsVoiceAsterisks) voice = c.ttsVoiceAsterisks;
        else if (segmentType === 'other' && c.ttsVoiceNarration) voice = c.ttsVoiceNarration;
    }
    
    if (!voice) {
        const voices = c.characterVoices || {};
        voice = (charName && voices[charName]) ? voices[charName] : c.ttsVoice;
    }
    
    return voice || '';
}

function getVoicesList() {
    const raw = getSettings().availableVoices || '';
    return raw.split(',').map(v => v.trim()).filter(Boolean);
}

function voiceLangCode(voiceName) {
    if (!voiceName) return 'en-US'; const n = voiceName.toLowerCase();
    if (n.endsWith('-jp') || n.endsWith('-jpn')) return 'ja-JP'; if (n.endsWith('-ko') || n.endsWith('-kor')) return 'ko-KR';
    if (n.endsWith('-zh') || n.endsWith('-zho')) return 'zh-CN'; if (n.endsWith('-de') || n.endsWith('-deu')) return 'de-DE';
    if (n.endsWith('-fr') || n.endsWith('-fra')) return 'fr-FR'; if (n.endsWith('-es') || n.endsWith('-esp')) return 'es-ES';
    return 'en-US';
}

// ── Cache & Context ───────────────────────────────────────────────────────────
const keyCache = new Map();
function cacheSet(mesid, data) { keyCache.set(Number(mesid), data); }
function cacheGet(mesid) { return keyCache.get(Number(mesid)); }
function cacheDel(mesid) { keyCache.delete(Number(mesid)); }
function cacheShiftAfterDelete(deletedIdx) {
    const idx = Number(deletedIdx);
    const entries = [...keyCache.entries()].filter(([k]) => k > idx);
    for (const [k] of entries) keyCache.delete(k);
    for (const [k, v] of entries) keyCache.set(k - 1, v);
}
function ctx() { return getContext() || {}; }

function getMsgInfo(mesEl) {
    const mesid = Number(mesEl.getAttribute('mesid'));
    const context = ctx();
    const msg = context.chat?.[mesid];
    
    if (!msg) return null;
    if (!context.chatId) return null;
    if (msg.is_system) return null;

    const isUser = msg.is_user || mesEl.classList.contains('user');
    const swipeId = msg.swipe_id ?? 0;
    const rawText = (msg.swipes?.[swipeId]) ?? msg.mes ?? '';
    
    // Properly grab historical names for User or Persona
    const charName = msg.name || (isUser ? (context.name1 || 'User') : (context.name2 || 'unknown'));
    const chatId = context.chatId;
    const dk = dateKey(msg.send_date);
    const akBase = `${dk}_s${swipeId}`;

    return { mesid, swipeId, rawText, msg, charName, chatId, dk, akBase, isUser };
}

// ── HYBRID ROUTING (EAGER vs BACKGROUND) ──────────────────────────────────────

const pendingServerJobs = new Map(); 

function requestGeneration(info, isManual) {
    if (info.isUser && !getSettings().narrateUserMessages) return;

    const currentActiveChat = ctx().chatId;
    if (info.chatId !== currentActiveChat && currentActiveChat !== undefined) {
        return; 
    }

    if (getSettings().abortOnChatChange && queueServingChatId !== info.chatId) {
        if (queueServingChatId !== null) {
            clearAllQueuesSyncAndFire();
        }
        queueServingChatId = info.chatId;
    } else if (!queueServingChatId) {
        queueServingChatId = info.chatId;
    }

    const c = getSettings();
    const testVoice = getVoiceForChar(info.charName, 'other');
    if (!testVoice || testVoice.toLowerCase() === 'none' || testVoice.toLowerCase() === 'disabled') {
        playerStatus(info.playerEl, 'no-audio', `No voice configured for ${info.charName}`);
        if (isManual && window.toastr) {
            toastr.warning(`No voice assigned for ${info.charName}. Please set one in the TTS Persist settings.`);
        }
        return; 
    }

    let useEagerStreaming = false;

    if (isManual) {
        if (c.differentVoicesForSegments || (!info.isUser && c.streamManualPlayback)) {
            useEagerStreaming = true;
        }
    }

    if (useEagerStreaming) {
        startEagerStreaming(info);
    } else {
        startServerQueue(info, isManual);
    }
}

// ── 1. BACKGROUND SERVER ENGINE ───────────────────────────────────────────────

async function startServerQueue(info, isPriority) {
    playerStatus(info.playerEl, isPriority ? 'generating' : 'queued', isPriority ? 'Generating on server...' : 'Queued on server...');
    
    const c = getSettings();
    let textToProcess = preprocessText(info.rawText, info.msg, info.charName);
    
    if (!textToProcess) {
        playerStatus(info.playerEl, 'no-audio', 'Text empty after filters');
        return;
    }

    const usePara = info.isUser ? false : c.chunkBackgroundRequests;
    const chunks = usePara ? smartSplitParagraphs(textToProcess, c.chunkMinLength) : [textToProcess];
    
    const finalInputs = [];
    chunks.forEach(chunk => {
        const segments = parseMessageSegments(chunk);
        segments.forEach(seg => {
            const cleanText = seg.text.trim();
            if (cleanText) finalInputs.push({ text: cleanText, voice: getVoiceForChar(info.charName, seg.type) });
        });
    });
    
    if (finalInputs.length === 0) {
        playerStatus(info.playerEl, 'no-audio', 'Text empty after filters');
        return;
    }
    
    let extra = {}; try { extra = JSON.parse(c.extraParams || '{}'); } catch {}

    const body = {
        ttsUrl: c.ttsEndpoint,
        ttsApiKey: c.ttsApiKey.trim() || 'sk-none',
        audioKey: info.akBase,
        textHash: info.hash,
        charName: info.charName,
        chatId: info.chatId,
        format: c.ttsFormat,
        priority: isPriority,
        chunkSilenceSeconds: c.chunkSilenceSeconds,
        ttsBody: {
            model: c.ttsModel,
            input: finalInputs, 
            response_format: c.ttsFormat,
            speed: c.ttsSpeed,
            ...extra
        }
    };
    if (c.ttsInstructions?.trim()) body.ttsBody.instructions = c.ttsInstructions.trim();

    try {
        await apiFetch(`${API}/queue/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: globalAbortController.signal 
        });
        pendingServerJobs.set(info.akBase, info);
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("[TTS Persist] Failed to queue to server:", e);
        playerStatus(info.playerEl, 'error', 'Server queue failed');
    }
}

// ── 2. ABORTABLE EAGER STREAMING ENGINE ───────────────────────────────────────

const eagerTtsQueue = [];
const activeEagerJobs = new Map(); 
let isEagerProcessing = false;
let isNukingEager = false; 
let eagerAbortController = null;
let currentEagerChunkJob = null;

const eagerAudioElement = new Audio();
eagerAudioElement.addEventListener('play', () => {
    if (eagerAudioElement._linkedPlayBtn) eagerAudioElement._linkedPlayBtn.textContent = '⏸';
});
eagerAudioElement.addEventListener('pause', () => {
    if (eagerAudioElement._linkedPlayBtn) eagerAudioElement._linkedPlayBtn.textContent = '▶';
});

// UI progress bar hook for Eager streaming mode
eagerAudioElement.addEventListener('timeupdate', () => {
    const job = Array.from(activeEagerJobs.values()).find(j => j.isPlaying);
    if (!job || !job.playerEl) return;
    
    const seekEl = job.playerEl.querySelector('.ttp-seek');
    const fill = job.playerEl.querySelector('.ttp-fill');
    const timeEl = job.playerEl.querySelector('.ttp-time');
    
    if (!eagerAudioElement.duration) return;
    
    const chunkPct = eagerAudioElement.currentTime / eagerAudioElement.duration;
    const totalPct = (job.playIndex + chunkPct) / job.totalChunks;
    
    seekEl.value = Math.round(totalPct * 1000);
    fill.style.width = (totalPct * 100).toFixed(2) + '%';
    timeEl.textContent = `[Stream] chunk ${job.playIndex + 1}/${job.totalChunks}`;
});

async function startEagerStreaming(info) {
    playerStatus(info.playerEl, 'generating', 'Generating chunks...');
    
    const c = getSettings();
    let textToProcess = preprocessText(info.rawText, info.msg, info.charName);
    
    if (!textToProcess) {
        playerStatus(info.playerEl, 'no-audio', 'Text empty after filters');
        return;
    }
    
    const usePara = info.isUser ? false : c.streamManualPlayback;
    const chunks = usePara ? smartSplitParagraphs(textToProcess, c.chunkMinLength) : [textToProcess];
    
    const parentJob = {
        ...info,
        totalChunks: 0,
        pendingChunks: 0,
        collectedBlobs: [],
        playableBlobs: [],
        playIndex: 0,
        isPlaying: false,
        silenceTimeoutId: null,
    };

    const newJobs = [];
    chunks.forEach(chunk => {
        const segments = parseMessageSegments(chunk);
        segments.forEach(seg => {
            const cleanText = seg.text.trim();
            if (cleanText) {
                parentJob.totalChunks++;
                parentJob.pendingChunks++;
                newJobs.push({
                    text: cleanText,
                    voice: getVoiceForChar(info.charName, seg.type),
                    parentJob: parentJob
                });
            }
        });
    });
    
    if (newJobs.length === 0) {
        playerStatus(info.playerEl, 'no-audio', 'Text empty after filters');
        return;
    }
    
    activeEagerJobs.set(info.akBase, parentJob);
    
    apiFetch(`${API}/queue/pause`, { method: 'POST', signal: globalAbortController.signal }).catch(()=>{});

    if (eagerAbortController) {
        eagerAbortController.abort();
        eagerAbortController = null;
        await new Promise(r => setTimeout(r, 50)); 
    }

    eagerTtsQueue.unshift(...newJobs);
    
    const playBtn = info.playerEl.querySelector('.ttp-play');
    if (playBtn) playBtn.removeAttribute('disabled');

    processEagerTtsQueue();
}

function playNextEagerChunk(job) {
    if (!job.isPlaying) return;

    if (job.playIndex < job.playableBlobs.length) {
        const blob = job.playableBlobs[job.playIndex];
        const url = URL.createObjectURL(blob);
        
        eagerAudioElement.src = url;
        eagerAudioElement.playbackRate = getSettings().audioPlaybackSpeed || 1.0;
        eagerAudioElement._linkedPlayBtn = job.playerEl.querySelector('.ttp-play');
        
        eagerAudioElement.onended = () => {
            URL.revokeObjectURL(url); 
            job.playIndex++;
            if (job.playIndex < job.totalChunks) {
                const silenceSec = parseFloat(getSettings().chunkSilenceSeconds) || 0;
                const fmt = getSettings().ttsFormat;
                if (silenceSec > 0 && (fmt === 'wav' || fmt === 'pcm')) {
                    job.silenceTimeoutId = setTimeout(() => {
                        job.silenceTimeoutId = null;
                        playNextEagerChunk(job);
                    }, silenceSec * 1000);
                } else {
                    playNextEagerChunk(job);
                }
            } else {
                job.isPlaying = false;
                if (job.pendingChunks === 0) {
                    activeEagerJobs.delete(job.akBase);
                }
                if (eagerAudioElement._linkedPlayBtn) eagerAudioElement._linkedPlayBtn.textContent = '▶';
                
                if (job.playerEl) {
                    const audio = job.playerEl.querySelector('audio');
                    if (audio && audio.readyState >= 1) {
                        audio.currentTime = audio.duration;
                    }
                }
            }
        };

        eagerAudioElement.play().catch(e => {
            console.warn("[TTS Persist] Eager play prevented by browser:", e);
            job.isPlaying = false;
            if (eagerAudioElement._linkedPlayBtn) eagerAudioElement._linkedPlayBtn.textContent = '▶';
        });

    } else if (job.playIndex < job.totalChunks) {
        if (eagerAudioElement._linkedPlayBtn) eagerAudioElement._linkedPlayBtn.textContent = '⏸ (Wait...)';
    }
}

async function processEagerTtsQueue() {
    if (isEagerProcessing) return;
    
    if (eagerTtsQueue.length === 0) {
        apiFetch(`${API}/queue/resume`, { method: 'POST', signal: globalAbortController.signal }).catch(()=>{});
        return;
    }
    
    isEagerProcessing = true;
    currentEagerChunkJob = eagerTtsQueue.shift();
    const c = getSettings();
    const parent = currentEagerChunkJob.parentJob;
    
    if (!activeEagerJobs.has(parent.akBase) || activeEagerJobs.get(parent.akBase) !== parent) {
        isEagerProcessing = false;
        processEagerTtsQueue();
        return;
    }
    
    eagerAbortController = new AbortController();
    
    try {
        let extra = {}; try { extra = JSON.parse(c.extraParams || '{}'); } catch {}
        
        const body = {
            ttsUrl: c.ttsEndpoint,
            ttsApiKey: c.ttsApiKey.trim() || 'sk-none',
            ttsBody: {
                model: c.ttsModel,
                input: currentEagerChunkJob.text,
                voice: currentEagerChunkJob.voice,
                response_format: c.ttsFormat,
                speed: c.ttsSpeed,
                ...extra
            }
        };
        if (c.ttsInstructions?.trim()) body.ttsBody.instructions = c.ttsInstructions.trim();

        const res = await apiFetch(`${API}/generate-eager`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: eagerAbortController.signal
        });

        if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);
        const blob = await res.blob();
        
        if (!activeEagerJobs.has(parent.akBase) || activeEagerJobs.get(parent.akBase) !== parent) {
            isEagerProcessing = false;
            processEagerTtsQueue();
            return;
        }

        parent.collectedBlobs.push(blob);
        parent.playableBlobs.push(blob);
        
        if (parent.isPlaying && eagerAudioElement.paused && parent.playIndex === parent.playableBlobs.length - 1) {
            playNextEagerChunk(parent);
        }

        parent.pendingChunks--;

        if (parent.pendingChunks === 0) {
            await finalizeAndSaveAudio(parent);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            if (isNukingEager) {
                console.log("[TTS Persist] 🛑 Eager Task Destroyed.");
            } else {
                console.log("[TTS Persist] ⏸ Eager Task Aborted & Re-queued.");
                eagerTtsQueue.unshift(currentEagerChunkJob); 
            }
        } else {
            console.error("[TTS Persist] Eager Fetch Failed:", e);
            if (parent.playerEl && document.contains(parent.playerEl)) {
                playerStatus(parent.playerEl, 'error', e.message);
            }
        }
    } finally {
        eagerAbortController = null;
        currentEagerChunkJob = null;
        isEagerProcessing = false;
        
        if (eagerTtsQueue.length === 0) isNukingEager = false; 
        
        processEagerTtsQueue();
    }
}

async function finalizeAndSaveAudio(parentJob) {
    try {
        if (!parentJob.collectedBlobs.length) return;
        
        const ttsFmt = getSettings().ttsFormat;
        const actualFormat = await detectFormatClient(parentJob.collectedBlobs[0], ttsFmt);
        const silenceSeconds = parseFloat(getSettings().chunkSilenceSeconds) || 0;
        
        let finalBlob;
        
        if (actualFormat === 'wav') {
            let totalLen = 0;
            const buffers = [];
            let sampleRate = 24000; 
            
            for (let i = 0; i < parentJob.collectedBlobs.length; i++) {
                const b = parentJob.collectedBlobs[i];
                const arr = await b.arrayBuffer();
                const { pcm, sampleRate: sr } = extractPcmFromWavArrayBuffer(arr);
                if (i === 0) sampleRate = sr;
                
                buffers.push(pcm);
                totalLen += pcm.length;

                if (silenceSeconds > 0 && i < parentJob.collectedBlobs.length - 1) {
                    const silenceBytes = Math.floor(sampleRate * 2 * silenceSeconds);
                    const silenceArr = new Uint8Array(silenceBytes);
                    buffers.push(silenceArr);
                    totalLen += silenceBytes;
                }
            }
            
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const arr of buffers) {
                merged.set(arr, offset);
                offset += arr.length;
            }
            finalBlob = await createWavBlob(new Blob([merged]), { sampleRate: sampleRate, bitDepth: 16, numChannels: 1 });
            
        } else if (actualFormat === 'mp3') {
            let totalLen = 0;
            const buffers = [];
            
            for (let i = 0; i < parentJob.collectedBlobs.length; i++) {
                const b = parentJob.collectedBlobs[i];
                const arr = await b.arrayBuffer();
                const clean = cleanMp3Data(new Uint8Array(arr));
                buffers.push(clean);
                totalLen += clean.length;
            }
            
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const arr of buffers) {
                merged.set(arr, offset);
                offset += arr.length;
            }
            finalBlob = new Blob([merged], { type: 'audio/mpeg' });
            
        } else {
            finalBlob = new Blob(parentJob.collectedBlobs, { type: parentJob.collectedBlobs[0].type });
        }

        const base64Data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(finalBlob);
        });
        
        const saveRes = await apiFetch(`${API}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audioKey: parentJob.akBase,
                textHash: parentJob.hash,
                charName: parentJob.charName,
                chatId: parentJob.chatId,
                audioData: base64Data,
                format: actualFormat === 'wav' ? 'wav' : ttsFmt
            }),
            signal: globalAbortController.signal 
        });

        if (!saveRes.ok) throw new Error("Failed to save merged audio to server");

        if (parentJob.playerEl && document.contains(parentJob.playerEl) && parentJob.playerEl.dataset.currentAk === parentJob.akBase) {
            loadAudio(parentJob.playerEl, buildAudioUrl(parentJob.charName, parentJob.chatId, parentJob.akBase), parentJob.hash);
        }
        
        if (!parentJob.isPlaying) {
            activeEagerJobs.delete(parentJob.akBase);
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error("[TTS Persist] Finalize Error:", e);
        if (parentJob.playerEl && document.contains(parentJob.playerEl)) {
            playerStatus(parentJob.playerEl, 'error', 'Merge/Save failed');
        }
        activeEagerJobs.delete(parentJob.akBase);
    }
}

// ── Batch Functions ──────────────────────────────────────────────────

function clearAllQueuesSyncAndFire() {
    isNukingEager = true; 
    eagerTtsQueue.length = 0;
    eagerAudioElement.pause();
    eagerAudioElement.src = '';
    
    if (eagerAbortController) {
        eagerAbortController.abort();
        eagerAbortController = null;
    }

    if (globalAbortController) {
        globalAbortController.abort(); 
        globalAbortController = new AbortController(); 
    }
    
    activeEagerJobs.forEach(job => {
        job.isPlaying = false;
        if (job.silenceTimeoutId) {
            clearTimeout(job.silenceTimeoutId);
            job.silenceTimeoutId = null;
        }
        if (job.playerEl) {
            const playBtn = job.playerEl.querySelector('.ttp-play');
            if (playBtn) playBtn.textContent = '▶';
        }
    });
    activeEagerJobs.clear();

    apiFetch(`${API}/queue/clear`, { method: 'POST', signal: globalAbortController.signal }).catch(()=>{});
    
    pendingServerJobs.clear();
    
    document.querySelectorAll('.ttp-dot[data-state="generating"], .ttp-dot[data-state="queued"]').forEach(dot => {
        const wrap = dot.closest('.ttp-wrap');
        playerStatus(wrap, 'no-audio');
        const playBtn = wrap.querySelector('.ttp-play');
        if (playBtn) playBtn.setAttribute('disabled', '');
    });
}

function clearAllQueues() {
    clearAllQueuesSyncAndFire();
}

function batchQueueMissing() {
    const narrateUser = getSettings().narrateUserMessages;
    document.querySelectorAll('.mes').forEach(mesEl => {
        const info = getMsgInfo(mesEl);
        if (!info) return;
        if (info.isUser && !narrateUser) return;

        mesEl.querySelectorAll('.ttp-wrap').forEach(wrap => {
            if (wrap.style.display === 'none') return;
            
            const state = wrap.querySelector('.ttp-dot')?.dataset?.state;
            if (state === 'no-audio' || state === 'error' || state === 'stale') {
                const infoStr = wrap.dataset.fullInfo;
                if (infoStr) {
                    const wrapInfo = JSON.parse(infoStr);
                    wrapInfo.playerEl = wrap; 
                    requestGeneration(wrapInfo, false); 
                }
            }
        });
    });
}

function batchRegenAll() {
    if (!confirm('Are you sure you want to regenerate all audio for this chat?')) return;
    
    const narrateUser = getSettings().narrateUserMessages;
    document.querySelectorAll('.mes').forEach(mesEl => {
        const info = getMsgInfo(mesEl);
        if (!info) return;
        if (info.isUser && !narrateUser) return;

        mesEl.querySelectorAll('.ttp-wrap').forEach(async wrap => {
            if (wrap.style.display === 'none') return;
            
            const infoStr = wrap.dataset.fullInfo;
            if (infoStr) {
                const wrapInfo = JSON.parse(infoStr);
                wrapInfo.playerEl = wrap;
                const audio = wrap.querySelector('audio');
                
                if (audio?.src) {
                    await apiFetch(buildAudioUrl(wrapInfo.charName, wrapInfo.chatId, wrapInfo.akBase), { method: 'DELETE', signal: globalAbortController.signal }).catch(()=>{});
                    clearAudio(wrap);
                }

                const activeJob = activeEagerJobs.get(wrapInfo.akBase);
                if (activeJob) {
                    activeJob.isPlaying = false;
                    if (activeJob.silenceTimeoutId) clearTimeout(activeJob.silenceTimeoutId);
                    if (eagerAudioElement._linkedPlayBtn === wrap.querySelector('.ttp-play')) eagerAudioElement.pause();
                    activeEagerJobs.delete(wrapInfo.akBase);
                }
                pendingServerJobs.delete(wrapInfo.akBase);

                requestGeneration(wrapInfo, false); 
            }
        });
    });
}

async function clearChatAudio() {
    if (!confirm('Delete all stored audio for the current chat? (This includes User messages and all Persona/Group members)')) return;
    
    const c = ctx();
    const chatId = c.chatId || 'unknown';
    
    await apiFetch(`${API}/chat-all/${encodeURIComponent(chatId)}`, { method: 'DELETE' }).catch(console.error);
    
    document.querySelectorAll('.ttp-wrap').forEach(clearAudio);
    keyCache.clear();
}

// ── Player state management ───────────────────────────────────────────────────

const STATES = {
    'no-audio': { icon: '○', tip: 'No audio — click ⟳ to generate' },
    generating: { icon: '⟳', tip: 'Generating…' },
    queued:     { icon: '…', tip: 'Queued for generation' },
    ready:      { icon: '●', tip: 'Ready' },
    stale:      { icon: '◐', tip: 'Audio may be outdated (text was edited)' },
    error:      { icon: '✕', tip: 'Error — click ⟳ to retry' }
};

function playerStatus(el, state, customTip) {
    if (!el) return;
    const dot = el.querySelector('.ttp-dot');
    if (!dot) return;
    
    const s = STATES[state] || STATES['no-audio'];
    dot.textContent = s.icon;
    dot.title = customTip || s.tip;
    dot.dataset.state = state;
    dot.classList.toggle('ttp-spin', state === 'generating');
}

function buildAudioUrl(charName, chatId, ak) {
    return `${API}/audio/${encodeURIComponent(charName)}/${encodeURIComponent(chatId)}/${encodeURIComponent(ak)}`;
}

function loadAudio(el, url, hash) {
    if (!el) return;
    const audio = el.querySelector('audio');
    if (!audio) return;
    
    audio.src = url + '?t=' + Date.now();
    audio.playbackRate = getSettings().audioPlaybackSpeed || 1.0;
    audio.load();
    
    el.dataset.loadedHash = hash || '';
    el.querySelector('.ttp-play')?.removeAttribute('disabled');
    playerStatus(el, 'ready');
}

function clearAudio(el) {
    if (!el) return;
    const audio = el.querySelector('audio');
    if (audio) { 
        audio.pause(); 
        audio.src = ''; 
        audio.load(); 
    }
    el.dataset.loadedHash = '';
    const playBtn = el.querySelector('.ttp-play');
    if (playBtn) playBtn.setAttribute('disabled', '');
    playerStatus(el, 'no-audio');
}

function fmtTime(s) {
    if (!isFinite(s) || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}

function makePlayer() {
    const wrap = document.createElement('div');
    wrap.className = 'ttp-wrap';
    
    const c = getSettings();
    const isMobile = window.innerWidth <= 768;
    if (isMobile ? c.collapseOnMobile : c.collapseOnPc) {
        wrap.classList.add('ttp-collapsed');
    }

    wrap.innerHTML = `
        <audio preload="none"></audio>
        <div class="ttp-bar">
            <span class="ttp-dot" data-state="no-audio" title="No audio">○</span>
            <button class="ttp-btn ttp-play" disabled title="Play / Pause">▶</button>
            <div class="ttp-track">
                <div class="ttp-fill"></div>
                <input class="ttp-seek" type="range" min="0" max="1000" value="0" step="1">
            </div>
            <span class="ttp-time">―</span>
            <button class="ttp-btn ttp-reload" title="Reload player for current swipe">↺</button>
            <button class="ttp-btn ttp-gen" title="Generate / Regenerate TTS">⟳</button>
            <button class="ttp-btn ttp-del" title="Delete Audio">🗑</button>
            <button class="ttp-btn ttp-tog" title="Collapse player">${wrap.classList.contains('ttp-collapsed') ? '+' : '−'}</button>
        </div>`;

    const audio = wrap.querySelector('audio');
    const playBtn = wrap.querySelector('.ttp-play');
    const seekEl = wrap.querySelector('.ttp-seek');
    const fill = wrap.querySelector('.ttp-fill');
    const timeEl = wrap.querySelector('.ttp-time');

    playBtn.addEventListener('click', () => {
        const akBase = wrap.dataset.currentAk;
        const activeJob = activeEagerJobs.get(akBase);

        if (activeJob) {
            if (activeJob.isPlaying) {
                activeJob.isPlaying = false;
                if (activeJob.silenceTimeoutId) {
                    clearTimeout(activeJob.silenceTimeoutId);
                    activeJob.silenceTimeoutId = null;
                }
                eagerAudioElement.pause();
                playBtn.textContent = '▶';

                if (activeJob.pendingChunks === 0) {
                    activeEagerJobs.delete(akBase);
                    if (audio.readyState >= 1 && audio.duration) {
                        audio.currentTime = (activeJob.playIndex / activeJob.totalChunks) * audio.duration;
                    } else {
                        audio.addEventListener('loadedmetadata', function onMeta() {
                            audio.currentTime = (activeJob.playIndex / activeJob.totalChunks) * audio.duration;
                            audio.removeEventListener('loadedmetadata', onMeta);
                        });
                    }
                }
                return;
            } else {
                if (activeJob.pendingChunks === 0) {
                    activeEagerJobs.delete(akBase);
                } else {
                    activeEagerJobs.forEach(job => {
                        if (job !== activeJob && job.isPlaying) {
                            job.isPlaying = false;
                            if (job.silenceTimeoutId) {
                                clearTimeout(job.silenceTimeoutId);
                                job.silenceTimeoutId = null;
                            }
                            const otherBtn = job.playerEl.querySelector('.ttp-play');
                            if (otherBtn) otherBtn.textContent = '▶';
                        }
                    });
                    document.querySelectorAll('.ttp-wrap audio').forEach(a => { if (!a.paused) a.pause(); });

                    activeJob.isPlaying = true;
                    playNextEagerChunk(activeJob);
                    return;
                }
            }
        }

        if (!audio.src || audio.error) return;
        
        if (audio.paused) {
            activeEagerJobs.forEach(job => {
                if (job.isPlaying) {
                    job.isPlaying = false;
                    if (job.silenceTimeoutId) {
                        clearTimeout(job.silenceTimeoutId);
                        job.silenceTimeoutId = null;
                    }
                    const otherBtn = job.playerEl.querySelector('.ttp-play');
                    if (otherBtn) otherBtn.textContent = '▶';
                }
            });
            eagerAudioElement.pause();
            
            document.querySelectorAll('.ttp-wrap audio').forEach(a => {
                if (a !== audio && !a.paused) a.pause();
            });
            
            audio.play();
        } else {
            audio.pause();
        }
    });

    audio.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });
    audio.addEventListener('ended', () => { playBtn.textContent = '▶'; });
    audio.addEventListener('canplay', () => {
        audio.playbackRate = getSettings().audioPlaybackSpeed || 1.0;
        playBtn.removeAttribute('disabled');
    });

    let isSeeking = false;
    audio.addEventListener('timeupdate', () => {
        if (!audio.duration || isSeeking) return;
        const pct = audio.currentTime / audio.duration;
        seekEl.value = Math.round(pct * 1000);
        fill.style.width = (pct * 100).toFixed(2) + '%';
        timeEl.textContent = fmtTime(audio.currentTime) + ' / ' + fmtTime(audio.duration);
    });
    
    seekEl.addEventListener('pointerup', () => {
        isSeeking = false;
        const akBase = wrap.dataset.currentAk;
        const activeJob = activeEagerJobs.get(akBase);

        if (activeJob) {
            if (activeJob.pendingChunks === 0) {
                activeJob.isPlaying = false;
                if (activeJob.silenceTimeoutId) clearTimeout(activeJob.silenceTimeoutId);
                if (eagerAudioElement._linkedPlayBtn === playBtn) eagerAudioElement.pause();
                activeEagerJobs.delete(akBase);
                playBtn.textContent = '▶';
            } else {
                return;
            }
        }

        if (audio.duration) {
            audio.currentTime = (seekEl.value / 1000) * audio.duration;
        }
    });

    wrap.querySelector('.ttp-reload').addEventListener('click', () => {
        const mesEl = wrap.closest('.mes');
        if (mesEl) inject(mesEl, false);
    });

    wrap.querySelector('.ttp-del').addEventListener('click', async () => {
        if (!confirm('Delete the audio file for this specific message?')) return;
        
        const akBase = wrap.dataset.currentAk;
        const infoStr = wrap.dataset.fullInfo;
        if (!infoStr) return;
        
        const info = JSON.parse(infoStr);

        const activeJob = activeEagerJobs.get(akBase);
        if (activeJob) {
            activeJob.isPlaying = false;
            if (activeJob.silenceTimeoutId) clearTimeout(activeJob.silenceTimeoutId);
            if (eagerAudioElement._linkedPlayBtn === playBtn) eagerAudioElement.pause();
            activeEagerJobs.delete(akBase);
        }
        pendingServerJobs.delete(akBase);

        await apiFetch(buildAudioUrl(info.charName, info.chatId, akBase), { method: 'DELETE', signal: globalAbortController.signal }).catch(()=>{});
        
        clearAudio(wrap);
    });

    wrap.querySelector('.ttp-tog').addEventListener('click', () => {
        const collapsed = wrap.classList.toggle('ttp-collapsed');
        wrap.querySelector('.ttp-tog').textContent = collapsed ? '+' : '−';
    });

    return wrap;
}

function wireGenButton(wrap, info) {
    const genBtn = wrap.querySelector('.ttp-gen');
    const newBtn = genBtn.cloneNode(true);
    genBtn.replaceWith(newBtn);

    newBtn.addEventListener('click', async () => {
        if (!getSettings().enabled) return;

        const activeJob = activeEagerJobs.get(info.akBase);
        if (activeJob) {
            activeJob.isPlaying = false;
            if (activeJob.silenceTimeoutId) clearTimeout(activeJob.silenceTimeoutId);
            if (eagerAudioElement._linkedPlayBtn === wrap.querySelector('.ttp-play')) eagerAudioElement.pause();
            activeEagerJobs.delete(info.akBase);
        }
        pendingServerJobs.delete(info.akBase);
        
        const audio = wrap.querySelector('audio');
        if (audio?.src) {
            await apiFetch(buildAudioUrl(info.charName, info.chatId, info.akBase), { method: 'DELETE', signal: globalAbortController.signal }).catch(()=>{});
            clearAudio(wrap);
        }
        
        requestGeneration(info, true); 
    });
}

function ensureContainer(mesEl) {
    let container = mesEl.querySelector('.ttp-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'ttp-container';
        
        container.style.marginRight = '85px'; 
        container.style.marginTop = '10px';
        container.style.clear = 'both';
        
        const mesText = mesEl.querySelector('.mes_text');
        if (mesText) {
            mesText.insertAdjacentElement('afterend', container);
        } else {
            mesEl.appendChild(container);
        }
    }
    return container;
}

// ── Injection Logic ──────────────────────────────────────────────────────────

let currentKnownChars = [];

async function inject(mesEl, forceRefresh = false) {
    const info = getMsgInfo(mesEl);
    if (!info) return;

    if (info.isUser && !getSettings().narrateUserMessages) return;

    const currentActiveChat = ctx().chatId;
    if (info.chatId !== currentActiveChat && currentActiveChat !== undefined) {
        return; 
    }

    if (getSettings().abortOnChatChange && queueServingChatId !== info.chatId) {
        if (queueServingChatId !== null) {
            clearAllQueuesSyncAndFire();
        }
        queueServingChatId = info.chatId;
    } else if (!queueServingChatId) {
        queueServingChatId = info.chatId;
    }

    if (!currentKnownChars.includes(info.charName)) {
        currentKnownChars.push(info.charName);
        refreshCharacterVoicesUI();
    }

    const item = { ...info, hash: textHash(info.rawText) };

    cacheSet(info.mesid, { dateKey: info.dk, charName: info.charName, chatId: info.chatId });
    await renderSinglePlayer(mesEl, item, forceRefresh);
}

async function renderSinglePlayer(mesEl, item, forceRefresh) {
    const container = ensureContainer(mesEl);
    
    const allWraps = container.querySelectorAll('.ttp-wrap');
    let wrap = null;
    
    allWraps.forEach(w => {
        if (w.dataset.currentAk !== item.akBase) {
            w.style.display = 'none'; 
            
            const audio = w.querySelector('audio');
            if (audio && !audio.paused) {
                audio.pause();
            }
            
            const activeJob = activeEagerJobs.get(w.dataset.currentAk);
            if (activeJob && activeJob.isPlaying) {
                activeJob.isPlaying = false;
                if (activeJob.silenceTimeoutId) clearTimeout(activeJob.silenceTimeoutId);
                if (eagerAudioElement._linkedPlayBtn === w.querySelector('.ttp-play')) {
                    eagerAudioElement.pause();
                }
                const playBtn = w.querySelector('.ttp-play');
                if (playBtn) playBtn.textContent = '▶';
            }
        } else {
            wrap = w; 
        }
    });

    let isHashChanged = false;
    if (wrap) {
        const oldInfoStr = wrap.dataset.fullInfo;
        if (oldInfoStr) {
            try {
                const oldInfo = JSON.parse(oldInfoStr);
                if (oldInfo.hash && oldInfo.hash !== item.hash) {
                    isHashChanged = true;
                }
            } catch(e){}
        }
    }

    if (wrap) {
        if (!forceRefresh && !isHashChanged) {
            wrap.style.display = 'flex'; 
            return;
        }
        
        clearAudio(wrap);
        wrap.remove();
        wrap = null;
    }

    wrap = makePlayer();
    wrap.dataset.currentAk = item.akBase;
    item.playerEl = wrap; 
    wrap.dataset.fullInfo = JSON.stringify(item); 
    
    wireGenButton(wrap, item);
    container.appendChild(wrap);

    if (activeEagerJobs.has(item.akBase)) {
        const job = activeEagerJobs.get(item.akBase);
        job.playerEl = wrap;
        playerStatus(wrap, 'generating', 'Generating chunks...');
        const playBtn = wrap.querySelector('.ttp-play');
        if (playBtn) playBtn.removeAttribute('disabled');
        return;
    }
    
    if (pendingServerJobs.has(item.akBase)) {
        const job = pendingServerJobs.get(item.akBase);
        job.playerEl = wrap;
        playerStatus(wrap, 'queued', 'Queued on server...');
        return;
    }

    await loadOrQueue(wrap, item);
}

async function loadOrQueue(wrap, item) {
    const { charName, chatId, akBase, hash } = item;
    let exists = false;
    let textHash = null;

    try {
        const r = await apiFetch(`${API}/check/${encodeURIComponent(charName)}/${encodeURIComponent(chatId)}/${encodeURIComponent(akBase)}`, { signal: globalAbortController.signal });
        const data = await r.json();
        exists = data.exists;
        textHash = data.textHash;
    } catch (e) { 
        if (e.name === 'AbortError') return; 
    }

    if (exists) {
        if (textHash && textHash !== hash) {
            if (getSettings().deleteOnEdit) {
                await apiFetch(buildAudioUrl(charName, chatId, akBase), { method: 'DELETE', signal: globalAbortController.signal }).catch(()=>{});
                playerStatus(wrap, 'no-audio');
                exists = false; 
            } else {
                loadAudio(wrap, buildAudioUrl(charName, chatId, akBase), textHash);
                playerStatus(wrap, 'stale');
                return;
            }
        } else {
            loadAudio(wrap, buildAudioUrl(charName, chatId, akBase), hash);
            return;
        }
    }

    if (!exists) {
        const context = ctx();
        const totalMsgs = context.chat?.length ?? 0;
        const mesid = Number(wrap.closest('.mes')?.getAttribute('mesid') ?? -1);
        const cSettings = getSettings();
        
        const shouldAuto = cSettings.enabled && cSettings.autoBackground && (mesid < (totalMsgs - cSettings.batchSkipLast));

        if (shouldAuto) {
            requestGeneration(item, false); 
        }
    }
}

// ── SillyTavern event hooks ───────────────────────────────────────────────────

function advanceSlidingWindow(latestMesId) {
    const c = getSettings();
    if (!c.enabled || !c.autoBackground || c.batchSkipLast <= 0) return;
    
    const targetMesId = Number(latestMesId) - c.batchSkipLast;
    if (targetMesId < 0) return;

    const targetEl = document.querySelector(`.mes[mesid="${targetMesId}"]`);
    if (!targetEl) return;

    const info = getMsgInfo(targetEl);
    if (!info) return;
    if (info.isUser && !c.narrateUserMessages) return;

    const activeWrap = Array.from(targetEl.querySelectorAll('.ttp-wrap')).find(w => w.style.display !== 'none');
    if (activeWrap && activeWrap.dataset.fullInfo) {
        const targetInfo = JSON.parse(activeWrap.dataset.fullInfo);
        targetInfo.playerEl = activeWrap;
        const state = activeWrap.querySelector('.ttp-dot')?.dataset?.state;
        
        if (state === 'no-audio') {
            requestGeneration(targetInfo, false);
        }
    }
}

function hookEvents() {
    const ev = window.eventSource;
    const et = window.event_types;
    if (!ev || !et) return;

    ev.on(et.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        if (el) inject(el, true);
        
        advanceSlidingWindow(mesId);
    });

    if (et.USER_MESSAGE_RENDERED) {
        ev.on(et.USER_MESSAGE_RENDERED, (mesId) => {
            advanceSlidingWindow(mesId);
            
            if (!getSettings().narrateUserMessages) return;
            const el = document.querySelector(`.mes[mesid="${mesId}"]`);
            if (el) inject(el, true);
        });
    }

    if (et.MESSAGE_UPDATED) {
        ev.on(et.MESSAGE_UPDATED, (mesId) => inject(document.querySelector(`.mes[mesid="${mesId}"]`), false));
    }
    if (et.MESSAGE_SWIPED) {
        ev.on(et.MESSAGE_SWIPED,  (mesId) => inject(document.querySelector(`.mes[mesid="${mesId}"]`), false));
    }

    if (et.MESSAGE_DELETED) {
        ev.on(et.MESSAGE_DELETED, (mesId) => {
            const cached = cacheGet(mesId);
            if (cached) {
                apiFetch(`${API}/slot/${encodeURIComponent(cached.charName)}/${encodeURIComponent(cached.chatId)}/${encodeURIComponent(cached.dateKey)}`, { method: 'DELETE' }).catch(()=>{});
                cacheDel(mesId);
            }
            cacheShiftAfterDelete(mesId);
        });
    }

    if (et.CHAT_CHANGED) {
        ev.on(et.CHAT_CHANGED, () => {            
            keyCache.clear();
            setTimeout(() => {
                injectAll();
                refreshCharacterVoicesUI();
            }, 400);
        });
    }
}

function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    new MutationObserver(muts => {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && n.classList?.contains('mes')) inject(n);
            }
        }
    }).observe(chat, { childList: true });
}

function injectAll() {
    const narrateUser = getSettings().narrateUserMessages;
    document.querySelectorAll('.mes').forEach(el => {
        const info = getMsgInfo(el);
        if (info) {
            if (info.isUser && !narrateUser) return;
            inject(el);
        }
    });
}

// ── Dynamic UI Data ───────────────────────────────────────────────────────────

let charVoicesContainer = null;

function getKnownCharacters() {
    const names = new Set();
    const context = ctx();

    if (context.name1) names.add(context.name1.trim()); 
    if (context.name2) names.add(context.name2.trim()); 
    
    if (context.groupId && Array.isArray(window.groups)) {
        const group = window.groups.find(g => String(g.id) === String(context.groupId));
        if (group && Array.isArray(group.members)) {
            const allChars = Array.isArray(context.characters) ? context.characters : (window.characters || []);
            group.members.forEach(memberAvatar => {
                const ch = allChars.find(c => c.avatar === memberAvatar);
                if (ch && ch.name) names.add(ch.name.trim());
            });
        }
    }

    if (Array.isArray(context.chat)) {
        context.chat.forEach(msg => {
            if (msg.name && msg.name !== 'unknown') {
                names.add(msg.name.trim());
            }
        });
    }

    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function refreshCharacterVoicesUI() {
    if (charVoicesContainer) {
        currentKnownChars = getKnownCharacters();
        buildCharacterVoicesSection(charVoicesContainer, currentKnownChars);
    }
}

function buildCharacterVoicesSection(container, charactersToRender = null) {
    const c = getSettings();
    const characters = charactersToRender || getKnownCharacters();
    const voicesList = getVoicesList();
    const cvMap = c.characterVoices || {};

    container.innerHTML = '';

    if (characters.length === 0) {
        container.innerHTML = '<div class="ttp-hint" style="padding:4px 0">No characters found. Open a chat to see characters here.</div>';
        return;
    }

    characters.forEach(charName => {
        const row = document.createElement('div');
        row.className = 'ttp-char-row';

        const nameEl = document.createElement('span');
        nameEl.className = 'ttp-char-name';
        nameEl.textContent = charName;
        nameEl.title = charName;

        const sel = document.createElement('select');
        sel.className = 'ttp-input ttp-char-sel';
        sel.title = `Voice for ${charName}`;

        const disabledOpt = document.createElement('option');
        disabledOpt.value = '';
        disabledOpt.textContent = '(default)';
        sel.appendChild(disabledOpt);

        voicesList.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            sel.appendChild(opt);
        });

        const currentVoice = cvMap[charName];
        if (currentVoice && !voicesList.includes(currentVoice)) {
            const missingOpt = document.createElement('option');
            missingOpt.value = currentVoice;
            missingOpt.textContent = currentVoice + ' (missing)';
            sel.appendChild(missingOpt);
        }
        sel.value = currentVoice || '';
        
        sel.addEventListener('change', () => {
            const s = getSettings();
            if (!s.characterVoices) s.characterVoices = {};
            if (sel.value) {
                s.characterVoices[charName] = sel.value;
            } else {
                delete s.characterVoices[charName];
            }
            saveSettings();
        });

        row.appendChild(nameEl);
        row.appendChild(sel);
        container.appendChild(row);
    });
}

// ── Available voices browser ──────────────────────────────────────────────────

let previewAudio = null;

async function previewVoice(voiceName) {
    const c = getSettings();
    if (!c.ttsEndpoint) return;
    try {
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        
        const body = {
            ttsUrl: c.ttsEndpoint,
            ttsApiKey: c.ttsApiKey.trim() || 'sk-none',
            ttsBody: {
                model: c.ttsModel,
                input: `Hello, this is a preview of the ${voiceName} voice.`,
                voice: voiceName,
                response_format: c.ttsFormat,
                speed: c.ttsSpeed,
                ...JSON.parse(c.extraParams || '{}')
            }
        };
        
        if (c.ttsInstructions?.trim()) {
            body.ttsBody.instructions = c.ttsInstructions.trim();
        }

        const res = await apiFetch(`${API}/generate-eager`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) return;

        const blob = await res.blob();
        let finalBlob = blob;
        
        if (c.ttsFormat === 'pcm' || c.ttsFormat === 'wav') {
            const arr = await blob.arrayBuffer();
            const { pcm, sampleRate } = extractPcmFromWavArrayBuffer(arr);
            finalBlob = await createWavBlob(new Blob([pcm]), { sampleRate, bitDepth: 16, numChannels: 1 });
        }

        previewAudio = new Audio(URL.createObjectURL(finalBlob));
        previewAudio.playbackRate = c.audioPlaybackSpeed || 1.0;
        previewAudio.play();
    } catch (e) { /* silent */ }
}

function buildVoicesBrowser(container) {
    const voices = getVoicesList();
    container.innerHTML = '';
    
    if (voices.length === 0) {
        container.innerHTML = '<div class="ttp-hint" style="padding:4px 0">Enter voices above to see them here.</div>';
        return;
    }

    voices.forEach(v => {
        const row = document.createElement('div');
        row.className = 'ttp-voice-row';

        const lang = document.createElement('span');
        lang.className = 'ttp-voice-lang';
        lang.textContent = voiceLangCode(v);

        const name = document.createElement('span');
        name.className = 'ttp-voice-name';
        name.textContent = v;

        const playBtn = document.createElement('button');
        playBtn.className = 'ttp-btn ttp-voice-play';
        playBtn.textContent = '▶';
        playBtn.title = `Preview voice: ${v}`;
        playBtn.addEventListener('click', () => previewVoice(v));

        row.appendChild(lang);
        row.appendChild(name);
        row.appendChild(playBtn);
        container.appendChild(row);
    });
}

// ── Settings UI ───────────────────────────────────────────────────────────────

function buildSettings() {
    const c = getSettings();
    const panel = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!panel) return;

    function chRow(id, label, checked) {
        return `
            <div class="ttp-row">
                <label class="ttp-switch-label">
                    ${label}
                    <label class="ttp-switch">
                        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
                        <span class="ttp-slider"></span>
                    </label>
                </label>
            </div>`;
    }

    const html = `
    <div class="ttp-settings">
        ${chRow('ttp-enabled', 'Enabled', c.enabled)}
        ${chRow('ttp-narrate-user', 'Narrate user messages', c.narrateUserMessages)}
        ${chRow('ttp-auto', 'Auto background generation', c.autoBackground)}
        ${chRow('ttp-abort-chat-change', 'Abort generation on chat change', c.abortOnChatChange)}
        
        <div class="ttp-divider"></div>
        ${chRow('ttp-collapse-mobile', 'Auto-collapse player on mobile', c.collapseOnMobile)}
        ${chRow('ttp-collapse-pc', 'Auto-collapse player on PC', c.collapseOnPc)}
        <div class="ttp-divider"></div>
        
        ${chRow('ttp-stream-manual', 'Manual Gen: Stream playback chunk by chunk', c.streamManualPlayback)}
        ${chRow('ttp-chunk-background', 'Background Gen: Send to API chunk by chunk', c.chunkBackgroundRequests)}
        
        <div class="ttp-row ttp-row-inline" style="margin-left: 20px;">
            <label>Chunk Min Length</label>
            <input class="ttp-input ttp-input-sm" type="number" id="ttp-chunk-min-length" value="${c.chunkMinLength}" min="0" max="2000" step="10">
            <span class="ttp-hint">chars (merges short paragraphs. 0 = disabled)</span>
        </div>
        <div class="ttp-row ttp-row-inline" style="margin-left: 20px;">
            <label>Silence Between Chunks</label>
            <input class="ttp-input ttp-input-sm" type="number" id="ttp-chunk-silence" value="${c.chunkSilenceSeconds}" min="0" max="10" step="0.5">
            <span class="ttp-hint">seconds (WAV/PCM format only)</span>
        </div>

        <div class="ttp-divider"></div>

        ${chRow('ttp-only-quotes', 'Only narrate &ldquo;quotes&rdquo;', c.onlyNarrateQuotes)}
        ${chRow('ttp-ignore-asterisks', 'Ignore <em>*text, even &ldquo;quotes&rdquo;, inside asterisks*</em>', c.ignoreAsterisksText)}
        ${chRow('ttp-only-translated', 'Narrate only the translated text', c.narrateOnlyTranslated)}
        ${chRow('ttp-skip-code', 'Skip codeblocks', c.skipCodeblocks)}
        ${chRow('ttp-skip-tags', 'Skip &lt;tagged&gt; blocks', c.skipTaggedBlocks)}
        ${chRow('ttp-pass-asterisks', 'Pass Asterisks to TTS Engine', c.passAsterisksToTTS)}
        ${chRow('ttp-diff-voices', 'Different voices for &ldquo;quotes&rdquo;, <em>*text inside asterisks*</em> and other text', c.differentVoicesForSegments)}
        ${chRow('ttp-regex-filter', 'Apply regex filters to text', c.applyRegexFilter)}

        <div class="ttp-row ttp-regex-block ${c.applyRegexFilter ? '' : 'ttp-hidden'}" style="flex-direction:column; align-items:flex-start; gap:5px;">
            <label>Regex Patterns <span class="ttp-hint">(one per line, removes matching text)</span></label>
            <textarea class="ttp-input ttp-textarea" id="ttp-regex-pattern" placeholder="Example:\\n/\\[.*?\\]/g\\n\\*\\*Stats:\\*\\*.*" style="width:100%; font-family:monospace;" rows="3">${c.regexPattern.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        </div>

        <div class="ttp-row ttp-segment-voices ${c.differentVoicesForSegments ? '' : 'ttp-hidden'}">
            <label>Voices for text segments</label>
            <div class="ttp-row-grid3">
                <div><label>Narration</label><select class="ttp-input" id="ttp-voice-narration"><option value="">(char voice)</option></select></div>
                <div><label>Quotes</label><select class="ttp-input" id="ttp-voice-quotes"><option value="">(char voice)</option></select></div>
                <div><label>Asterisks</label><select class="ttp-input" id="ttp-voice-asterisks"><option value="">(char voice)</option></select></div>
            </div>
        </div>

        <div class="ttp-row">
            <label class="ttp-switch-label" style="justify-content:flex-start;gap:10px">
                <span>Audio Playback Speed</span><span id="ttp-playback-speed-val" style="color:#6fcf97;font-size:0.9em">${c.audioPlaybackSpeed.toFixed(2)}</span>
            </label>
            <input type="range" id="ttp-playback-speed" class="ttp-slider-input" min="0.25" max="4" step="0.05" value="${c.audioPlaybackSpeed}">
        </div>

        <div class="ttp-divider"></div>
        
        <div class="ttp-row ttp-row-inline">
            <label>Skip newest</label>
            <input class="ttp-input ttp-input-sm" type="number" id="ttp-skip" value="${c.batchSkipLast}" min="0" max="50" step="1">
            <span class="ttp-hint">messages from auto-queue (lazy generation)</span>
        </div>
        ${chRow('ttp-delonedit', 'Delete audio when message is edited', c.deleteOnEdit)}
        ${chRow('ttp-keepswipe', 'Keep audio for non-active swipes', c.keepSwipeAudio)}
        
        <div class="ttp-divider"></div>

        <div class="ttp-row">
            <label>[Default Voice]</label>
            <select class="ttp-input" id="ttp-voice-global"><option value="">disabled</option></select>
        </div>

        <div class="ttp-row">
            <div class="ttp-section-header">
                <span>Character voices</span>
                <button class="ttp-abtn" id="ttp-refresh-chars" title="Re-scan characters from current chat">↺ Refresh</button>
            </div>
            <div id="ttp-char-voices-list" class="ttp-char-voices-list"></div>
        </div>

        <div class="ttp-divider"></div>

        <div class="ttp-row"><label>Provider Endpoint (OpenAI/VibeVoice API)</label><input class="ttp-input" type="text" id="ttp-endpoint" value="${c.ttsEndpoint}"></div>
        <div class="ttp-row"><label>API Key</label><input class="ttp-input" type="password" id="ttp-apikey" value="${c.ttsApiKey}"></div>
        <div class="ttp-row"><label>Model</label><input class="ttp-input" type="text" id="ttp-model" value="${c.ttsModel}"></div>
        
        <div class="ttp-row ttp-row-inline" style="margin-top: 5px; margin-bottom: 5px;">
            <button class="ttp-abtn" id="ttp-test-connection">📡 Test Connection</button>
            <span id="ttp-test-result" style="font-size: 0.85em; margin-left: 10px; font-weight: bold;"></span>
        </div>

        <div class="ttp-row">
            <label>Available Voices <span class="ttp-hint">(comma separated)</span></label>
            <textarea class="ttp-input ttp-textarea" id="ttp-avail-voices" rows="2">${c.availableVoices}</textarea>
        </div>

        <div class="ttp-row">
            <label class="ttp-switch-label" style="justify-content:flex-start;gap:10px">
                <span>Speed</span><span id="ttp-speed-val" style="color:#6fcf97;font-size:0.9em">${c.ttsSpeed.toFixed(2)}</span>
            </label>
            <input type="range" id="ttp-speed" class="ttp-slider-input" min="0.25" max="4" step="0.05" value="${c.ttsSpeed}">
        </div>

        <div class="ttp-row ttp-row-grid2">
            <div><label>Format</label><select class="ttp-input" id="ttp-format">${['mp3','opus','aac','flac','wav','pcm'].map(f => `<option value="${f}" ${c.ttsFormat===f?'selected':''}>${f}</option>`).join('')}</select></div>
            <div><label>Instructions</label><input class="ttp-input" type="text" id="ttp-instructions" value="${c.ttsInstructions}"></div>
        </div>

        <div class="ttp-row"><label>Extra params</label><textarea class="ttp-input ttp-textarea" id="ttp-extra" rows="3">${c.extraParams}</textarea></div>
        
        <div class="ttp-divider"></div>
        
        <div class="ttp-row ttp-actions">
            <button class="ttp-abtn" id="ttp-queue-missing">⟳ Queue missing</button>
            <button class="ttp-abtn" id="ttp-regen-all">⟳⟳ Regen all</button>
            <button class="ttp-abtn ttp-danger" id="ttp-clear-server">🛑 Clear Queue</button>
            <button class="ttp-abtn ttp-danger" id="ttp-clear-chat">✕ Clear chat</button>
        </div>
        <div class="ttp-queue-info" id="ttp-queue-info">Queue: idle</div>
        
        <button class="ttp-abtn" id="ttp-toggle-debug" style="width:fit-content; padding:2px 8px; font-size: 0.75em;">Log ▼</button>
        <textarea id="ttp-queue-debug" class="ttp-input ttp-textarea ttp-hidden" readonly style="font-size: 0.75em; min-height: 80px; max-height: 150px; background: rgba(0,0,0,0.5);"></textarea>

        <div class="ttp-divider"></div>

        <div class="ttp-row">
            <div class="ttp-section-header"><span>Available voices</span><button class="ttp-abtn" id="ttp-toggle-voices">▼ Show</button></div>
            <div id="ttp-voices-browser" class="ttp-voices-browser ttp-hidden"></div>
        </div>
    </div>`;

    const section = document.createElement('div');
    section.className = 'extension_settings';
    section.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>TTS Persist</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">${html}</div></div>`;
    panel.appendChild(section);

    const $ = id => section.querySelector('#' + id);

    function repopulateVoiceSelects() {
        const voices = getVoicesList();
        ['ttp-voice-global', 'ttp-voice-narration', 'ttp-voice-quotes', 'ttp-voice-asterisks'].forEach(selId => {
            const sel = $(selId);
            if (!sel) return;
            const s = getSettings();
            let current = sel.value || s[selId === 'ttp-voice-global' ? 'ttsVoice' :
                                         selId === 'ttp-voice-narration' ? 'ttsVoiceNarration' :
                                         selId === 'ttp-voice-quotes' ? 'ttsVoiceQuotes' : 'ttsVoiceAsterisks'];
            
            while (sel.options.length > 1) sel.remove(1); 
            
            voices.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                sel.appendChild(opt);
            });
            
            if (current && !voices.includes(current)) {
                const missingOpt = document.createElement('option');
                missingOpt.value = current;
                missingOpt.textContent = current + ' (missing)';
                sel.appendChild(missingOpt);
            }
            sel.value = current || '';
        });
        refreshCharacterVoicesUI();
    }

    function syncCfg() {
        try {
            const s = getSettings();
            
            s.enabled = $('ttp-enabled').checked;
            s.narrateUserMessages = $('ttp-narrate-user').checked;
            s.autoBackground = $('ttp-auto').checked;
            s.abortOnChatChange = $('ttp-abort-chat-change').checked;
            s.collapseOnMobile = $('ttp-collapse-mobile').checked;
            s.collapseOnPc = $('ttp-collapse-pc').checked;
            
            s.streamManualPlayback = $('ttp-stream-manual').checked;
            s.chunkBackgroundRequests = $('ttp-chunk-background').checked;

            s.chunkMinLength = parseInt($('ttp-chunk-min-length').value, 10) || 0;
            s.chunkSilenceSeconds = parseFloat($('ttp-chunk-silence').value) || 0;

            s.onlyNarrateQuotes = $('ttp-only-quotes').checked;
            s.ignoreAsterisksText = $('ttp-ignore-asterisks').checked;
            s.narrateOnlyTranslated = $('ttp-only-translated').checked;
            s.skipCodeblocks = $('ttp-skip-code').checked;
            s.skipTaggedBlocks = $('ttp-skip-tags').checked;
            s.passAsterisksToTTS = $('ttp-pass-asterisks').checked;
            s.differentVoicesForSegments = $('ttp-diff-voices').checked;
            s.applyRegexFilter = $('ttp-regex-filter').checked;
            s.regexPattern = $('ttp-regex-pattern').value;
            
            s.batchSkipLast = parseInt($('ttp-skip').value, 10);
            if (isNaN(s.batchSkipLast)) s.batchSkipLast = 0;

            s.deleteOnEdit = $('ttp-delonedit').checked;
            s.keepSwipeAudio = $('ttp-keepswipe').checked;
            
            s.ttsVoice = $('ttp-voice-global').value;
            s.ttsVoiceNarration = $('ttp-voice-narration').value;
            s.ttsVoiceQuotes = $('ttp-voice-quotes').value;
            s.ttsVoiceAsterisks = $('ttp-voice-asterisks').value;
            
            s.ttsEndpoint = $('ttp-endpoint').value;
            s.ttsApiKey = $('ttp-apikey').value;
            s.ttsModel = $('ttp-model').value;
            s.ttsSpeed = parseFloat($('ttp-speed').value) || 1.0;
            s.audioPlaybackSpeed = parseFloat($('ttp-playback-speed').value) || 1.0;
            s.ttsFormat = $('ttp-format').value;
            s.ttsInstructions = $('ttp-instructions').value;
            
            const extraVal = $('ttp-extra').value.trim();
            if (!extraVal) {
                s.extraParams = '{}';
            } else {
                try { JSON.parse(extraVal); s.extraParams = extraVal; } catch {}
            }

            const regexBlock = section.querySelector('.ttp-regex-block');
            if (regexBlock) regexBlock.classList.toggle('ttp-hidden', !s.applyRegexFilter);

            const segDiv = section.querySelector('.ttp-segment-voices');
            if (segDiv) segDiv.classList.toggle('ttp-hidden', !s.differentVoicesForSegments);
            
            saveSettings();
        } catch (err) {
            console.error('[TTS Persist] Error syncing config:', err);
        }
    }

    let voiceTimer;
    $('ttp-avail-voices').addEventListener('input', (e) => {
        clearTimeout(voiceTimer);
        voiceTimer = setTimeout(() => {
            const s = getSettings();
            s.availableVoices = e.target.value;
            repopulateVoiceSelects();
            buildVoicesBrowser($('ttp-voices-browser'));
            saveSettings();
        }, 500);
    });

    $('ttp-speed').addEventListener('input', () => { 
        $('ttp-speed-val').textContent = parseFloat($('ttp-speed').value).toFixed(2); 
        syncCfg(); 
    });

    $('ttp-playback-speed').addEventListener('input', () => {
        $('ttp-playback-speed-val').textContent = parseFloat($('ttp-playback-speed').value).toFixed(2);
        document.querySelectorAll('.ttp-wrap audio').forEach(a => {
            a.playbackRate = parseFloat($('ttp-playback-speed').value) || 1.0;
        });
        syncCfg();
    });

    section.addEventListener('input', (e) => {
        if (e.target.id === 'ttp-avail-voices') return; 
        if (e.target.id === 'ttp-speed' || e.target.id === 'ttp-playback-speed') return; 
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
            syncCfg();
        }
    });

    charVoicesContainer = $('ttp-char-voices-list');
    repopulateVoiceSelects();
    $('ttp-refresh-chars').addEventListener('click', refreshCharacterVoicesUI);

    const voicesBrowser = section.querySelector('#ttp-voices-browser');
    buildVoicesBrowser(voicesBrowser);
    $('ttp-toggle-voices').addEventListener('click', () => {
        const hidden = voicesBrowser.classList.toggle('ttp-hidden');
        $('ttp-toggle-voices').textContent = hidden ? '▼ Show' : '▲ Hide';
    });

    const debugBox = section.querySelector('#ttp-queue-debug');
    $('ttp-toggle-debug').addEventListener('click', () => {
        const hidden = debugBox.classList.toggle('ttp-hidden');
        $('ttp-toggle-debug').textContent = hidden ? 'Log ▼' : 'Log ▲';
    });

    // ── TEST CONNECTION BUTTON LOGIC ──
    $('ttp-test-connection').addEventListener('click', async () => {
        const btn = $('ttp-test-connection');
        const resEl = $('ttp-test-result');
        
        syncCfg(); 
        const c = getSettings();
        
        if (!c.ttsEndpoint) {
            resEl.textContent = '❌ Error: Endpoint is empty';
            resEl.style.color = '#eb5757';
            return;
        }

        btn.disabled = true;
        btn.style.opacity = '0.5';
        resEl.textContent = 'Testing connection...';
        resEl.style.color = '#f2c94c';

        try {
            let extra = {}; try { extra = JSON.parse(c.extraParams || '{}'); } catch {}
            
            const body = {
                ttsUrl: c.ttsEndpoint,
                ttsApiKey: c.ttsApiKey.trim() || 'sk-none',
                ttsBody: {
                    model: c.ttsModel,
                    input: "Connection test successful.",
                    voice: c.ttsVoice || 'default',
                    response_format: c.ttsFormat,
                    speed: c.ttsSpeed,
                    ...extra
                }
            };

            const res = await apiFetch(`${API}/generate-eager`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`HTTP ${res.status}: ${errText}`);
            }
            
            const blob = await res.blob();
            if (blob.size > 0) {
                resEl.textContent = '✅ Connected successfully!';
                resEl.style.color = '#6fcf97';
            } else {
                throw new Error('API returned an empty file.');
            }

        } catch (err) {
            console.error('[TTS Persist] Test Connection Error:', err);
            resEl.textContent = `❌ ${err.message}`;
            resEl.style.color = '#eb5757';
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    });

    $('ttp-queue-missing').addEventListener('click', batchQueueMissing);
    $('ttp-regen-all').addEventListener('click', batchRegenAll);
    $('ttp-clear-server').addEventListener('click', clearAllQueues);
    $('ttp-clear-chat').addEventListener('click', clearChatAudio);
}

function init() {
    buildSettings();
    hookEvents();
    observeChat();
    injectAll();
    
    // Polling Loop: Checks UI state and polls Server for background jobs
    setInterval(async () => {
        const qInfo = document.getElementById('ttp-queue-info');
        const debugBox = document.getElementById('ttp-queue-debug');
        let qRes = { active: null, pending: [] };
        
        try {
            qRes = await apiFetch(`${API}/queue/status`).then(r=>r.json());
        } catch(e) {}

        const frontEndQ = eagerTtsQueue.length;
        if (qInfo) {
            if (qRes.active || qRes.pending.length > 0 || frontEndQ > 0 || isEagerProcessing) {
                qInfo.textContent = `Queue: ${qRes.active || isEagerProcessing ? '⟳ working' : 'waiting'} · Server: ${qRes.pending.length} · Eager: ${frontEndQ}`;
            } else {
                qInfo.textContent = 'Queue: idle';
            }
        }

        // ── POPULATE DEBUG LOG UI ──
        if (debugBox && !debugBox.classList.contains('ttp-hidden')) {
            let debugText = [];
            if (qRes.active) debugText.push(`[SERVER] ACTIVE: ${qRes.active}`);
            qRes.pending.forEach((p, i) => debugText.push(`[SERVER] Wait ${i+1}: ${p}`));
            
            if (currentEagerChunkJob) debugText.push(`[EAGER] ACTIVE: Chunk for ${currentEagerChunkJob.parentJob.akBase}`);
            eagerTtsQueue.forEach((q, i) => debugText.push(`[EAGER] Wait ${i+1}: Chunk for ${q.parentJob.akBase}`));

            debugBox.value = debugText.length > 0 ? debugText.join('\n') : 'No tasks running or queued.';
        }

        // ── LIVE UI QUEUE DOT UPDATES ──
        for (const [ak, info] of pendingServerJobs.entries()) {
            if (!info.playerEl || !document.contains(info.playerEl)) continue;
            if (info.playerEl.dataset.currentAk !== ak) continue;

            if (qRes.active === ak) {
                playerStatus(info.playerEl, 'generating', 'Generating on server...');
            } else if (qRes.pending.includes(ak)) {
                playerStatus(info.playerEl, 'queued', 'Queued on server...');
            }

            try {
                const r = await apiFetch(`${API}/check/${encodeURIComponent(info.charName)}/${encodeURIComponent(info.chatId)}/${encodeURIComponent(ak)}`);
                const data = await r.json();
                if (data.exists) {
                    pendingServerJobs.delete(ak);
                    loadAudio(info.playerEl, buildAudioUrl(info.charName, info.chatId, ak), data.textHash);
                }
            } catch(e) {}
        }
    }, 2000);
}

// ── Execute on Ready ────────────────────────────────────────────────────────
jQuery(async () => {
    init();
});