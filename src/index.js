const BADGE_CLASS = 'persona_age_badge';
const METADATA_KEY = 'persona_age_override';

const AGE_PATTERNS = [
    /\bage\s*:\s*(\d+)\b/i,
    /\b(\d+)\s*(?:years?\s*old|year)\b/i,
    /\b(\d+)\s*(?:yo|y\.?\s*o\.?)\b/i,
    /\b(\d+)-year-old\b/i,
];

function log(...args) {
    console.log('[Personage]', ...args);
}

const seenLogKeys = new Set();
function logOnce(key, ...args) {
    if (seenLogKeys.has(key)) return;
    seenLogKeys.add(key);
    console.log('[Personage]', ...args);
}

const lastLogAt = new Map();
function logThrottled(ms, ...args) {
    const key = String(args[0] ?? '');
    const now = Date.now();
    if (now - (lastLogAt.get(key) || 0) < ms) return;
    lastLogAt.set(key, now);
    console.log('[Personage]', ...args);
}

function stripTemplateTags(text) {
    return text.replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAgeFromDescription(text) {
    if (!text || typeof text !== 'string') return null;
    const cleaned = stripTemplateTags(text);
    for (const p of AGE_PATTERNS) {
        const m = cleaned.match(p);
        if (m) {
            const age = parseInt(m[1], 10);
            if (!isNaN(age) && age > 0 && age < 200) return age;
        }
    }
    return null;
}

function resolveDefaultPersonaText() {
    try {
        const ctx = SillyTavern.getContext();
        const raw = ctx.powerUserSettings?.persona_description?.trim();
        if (!raw) return null;
        let text = raw
            .replace(/\{\{user\}\}/gi, ctx.name1 || '')
            .replace(/\{\{char\}\}/gi, ctx.name2 || '')
            .replace(/\{\{name\}\}/gi, ctx.name1 || '');
        text = stripTemplateTags(text);
        return text || null;
    } catch (e) {
        console.error('Personage: resolveDefaultPersonaText error', e);
        return null;
    }
}

function findDefaultAgeInText(text) {
    if (!text || typeof text !== 'string') return null;
    for (const p of AGE_PATTERNS) {
        const m = text.match(p);
        if (m) {
            const age = parseInt(m[1], 10);
            if (!isNaN(age) && age > 0 && age < 200) return age;
        }
    }
    return null;
}

function getCurrentPersonaOverride() {
    const ctx = SillyTavern.getContext();
    const name = ctx.name1 || '';
    const meta = ctx.chatMetadata?.[METADATA_KEY];
    let map = {};
    if (typeof meta === 'number') {
        map = { [name]: meta };
    } else if (typeof meta === 'string' && meta.trim() !== '' && !isNaN(parseInt(meta, 10))) {
        map = { [name]: meta };
    } else if (meta && typeof meta === 'object') {
        map = meta;
    }
    const v = map?.[name];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) return n;
    }
    return null;
}

function getResolvedAge() {
    try {
        const ctx = SillyTavern.getContext();
        const override = getCurrentPersonaOverride();
        if (override !== null && override > 0 && override < 200) {
            logOnce(`override:${override}`, 'resolve: persona override =', override);
            return { age: override, isOverride: true };
        }
        const desc = ctx.powerUserSettings?.persona_description || '';
        if (!desc) {
            logOnce('no-desc', 'resolve: no persona_description set');
            return null;
        }
        const parsed = parseAgeFromDescription(desc);
        if (parsed) {
            logOnce(`parsed:${parsed}`, 'resolve: parsed age from persona_description =', parsed);
            return { age: parsed, isOverride: false };
        }
        logOnce('no-age', 'resolve: no age found in persona_description');
        return null;
    } catch (error) {
        console.error('Personage: getResolvedAge error', error);
        return null;
    }
}

function findAgeMatches(text) {
    const matches = [];
    for (const p of AGE_PATTERNS) {
        const re = new RegExp(p.source, 'gi');
        let m;
        while ((m = re.exec(text)) !== null) {
            const value = parseInt(m[1], 10);
            if (!isNaN(value) && value > 0 && value < 200) {
                const start = m.index + m[0].indexOf(m[1]);
                matches.push({ value, start, len: m[1].length });
            }
        }
    }
    return matches;
}

function messageShowsAge(text, age) {
    return findAgeMatches(text).some(m => m.value === age);
}

function replaceSpecificAges(text, oldAge, newAge) {
    const targets = findAgeMatches(text).filter(m => m.value === oldAge);
    if (!targets.length) return null;
    let result = text;
    for (const m of targets.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, m.start) + String(newAge) + result.slice(m.start + m.len);
    }
    return result;
}

function onChatCompletionPromptReady(data) {
    try {
        if (data.dryRun) return;
        const resolved = getResolvedAge();
        if (!resolved || !resolved.isOverride) {
            logOnce('prompt:no-override', 'prompt: skip rewrite (no chat override set)', resolved);
            return;
        }
        const ctx = SillyTavern.getContext();
        const userName = ctx.name1;
        if (!userName) {
            logOnce('prompt:no-user', 'prompt: skip rewrite (no {{user}} name)');
            return;
        }
        const defaultAge = findDefaultAgeInText(resolveDefaultPersonaText());
        if (!defaultAge || defaultAge === resolved.age) {
            logOnce(`prompt:default:${defaultAge}`, 'prompt: skip rewrite (default age', defaultAge, '== override', resolved.age, ')');
            return;
        }
        const chat = Array.isArray(data.chat) ? data.chat : [];
        const withAge = chat.filter(m => typeof m.content === 'string' && messageShowsAge(m.content, defaultAge));
        const personaCandidates = withAge.filter(m => m.role === 'system' || (typeof m.content === 'string' && m.content.includes(userName)));
        if (!personaCandidates.length) {
            logOnce('prompt:no-persona-msg', 'prompt: skip rewrite (no message containing default age', defaultAge, 'found)');
            return;
        }
        let replaced = 0;
        for (const m of chat) {
            if (typeof m.content !== 'string') continue;
            const newContent = replaceSpecificAges(m.content, defaultAge, resolved.age);
            if (newContent !== null && newContent !== m.content) {
                m.content = newContent;
                replaced++;
            }
        }
        if (!replaced) {
            logOnce('prompt:no-change', 'prompt: skip rewrite (no age', defaultAge, 'found in persona messages)');
            return;
        }
        logThrottled(1500, `prompt: rewrote`, replaced, 'message(s): age', defaultAge, '->', resolved.age);
    } catch (e) {
        console.error('Personage: onChatCompletionPromptReady error', e);
    }
}

function readOverrideMap() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata?.[METADATA_KEY];
    if (typeof meta === 'number') return {};
    if (typeof meta === 'string' && meta.trim() !== '' && !isNaN(parseInt(meta, 10))) return {};
    if (meta && typeof meta === 'object') return { ...meta };
    return {};
}

async function promptEditAge() {
    const ctx = SillyTavern.getContext();
    const current = getResolvedAge();
    const result = await ctx.Popup.show.input(
        'Edit Persona Age',
        `Enter age for this persona, or leave empty to reset it to its default.`,
        current ? String(current.age) : '',
    );
    if (result === null) return;
    const map = readOverrideMap();
    const trimmed = result.trim();
    if (!trimmed) {
        delete map[ctx.name1];
        if (Object.keys(map).length) {
            ctx.chatMetadata[METADATA_KEY] = map;
        } else {
            delete ctx.chatMetadata[METADATA_KEY];
        }
        await ctx.saveMetadata();
        refreshAllBadges();
        log('edit: age override cleared for persona', ctx.name1);
        return;
    }
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n <= 0 || n >= 200) {
        toastr.warning('Please enter a valid age (1-199).');
        return;
    }
    map[ctx.name1] = n;
    ctx.chatMetadata[METADATA_KEY] = map;
    await ctx.saveMetadata();
    refreshAllBadges();
    log('edit: age override set to', n, 'for persona', ctx.name1);
}

function addAgeBadge(messageId) {
    const nameSpan = document.querySelector(`.mes[mesid="${messageId}"] .ch_name .name_text`);
    if (!nameSpan) {
        logOnce(`badge:no-name:${messageId}`, `badge[${messageId}]: name span not found`);
        return;
    }
    const resolved = getResolvedAge();
    let badge = nameSpan.parentElement?.querySelector(`.${BADGE_CLASS}`);
    if (!resolved) {
        if (badge) {
            badge.remove();
            logThrottled(1500, 'badge: removed (no age resolved)', `for msg ${messageId}`);
        }
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.addEventListener('click', promptEditAge);
        nameSpan.insertAdjacentElement('afterend', badge);
        logThrottled(1500, 'badge: created', `msg ${messageId}`, `age = ${resolved.age}`, resolved.isOverride ? '(override)' : '(from persona)');
    }
    badge.textContent = ` (${resolved.age}${resolved.isOverride ? '*' : ''})`;
    badge.dataset.isOverride = String(resolved.isOverride);
}

function addPersonaPanelBadge() {
    const nameEl = document.querySelector('#persona_controls .persona_name');
    if (!nameEl) {
        logOnce('panel:no-name', 'panel: persona name element not found');
        return;
    }
    const resolved = getResolvedAge();
    let badge = nameEl.querySelector(`.${BADGE_CLASS}`);
    if (!resolved) {
        if (badge) {
            badge.remove();
            logThrottled(1500, 'panel: removed badge (no age resolved)');
        }
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.addEventListener('click', promptEditAge);
        nameEl.appendChild(badge);
        logThrottled(1500, 'panel: badge created', `age = ${resolved.age}`, resolved.isOverride ? '(override)' : '(from persona)');
    }
    const label = ` (${resolved.age}${resolved.isOverride ? '*' : ''})`;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.dataset.isOverride !== String(resolved.isOverride)) badge.dataset.isOverride = String(resolved.isOverride);
}

function watchPersonaNameForBadge() {
    const nameEl = document.querySelector('#persona_controls .persona_name');
    if (!nameEl) {
        logOnce('panel:no-name-el', 'watch: persona name element not found');
        return;
    }
    new MutationObserver(() => addPersonaPanelBadge()).observe(nameEl, { childList: true, characterData: true, subtree: true });
    log('watch: observing persona name element');
}

function refreshAllBadges() {
    addPersonaPanelBadge();
    document.querySelectorAll('.mes[is_user="true"]').forEach(mes => {
        const mid = mes.getAttribute('mesid');
        if (mid !== null) addAgeBadge(mid);
    });
}

function onUserMessageRendered(messageId) {
    addAgeBadge(messageId);
}

function onChatChanged() {
    setTimeout(refreshAllBadges, 100);
}

function onPersonaUpdated() {
    setTimeout(refreshAllBadges, 100);
}

function init() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.eventSource.on(ctx.eventTypes.USER_MESSAGE_RENDERED, onUserMessageRendered);
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);
        ctx.eventSource.on(ctx.eventTypes.PERSONA_CHANGED, onChatChanged);
        ctx.eventSource.on(ctx.eventTypes.PERSONA_UPDATED, onPersonaUpdated);
        ctx.eventSource.makeFirst(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
        watchPersonaNameForBadge();
        setTimeout(refreshAllBadges, 500);
        log('init: registered event listeners');
    } catch (error) {
        console.error('Personage: init failed', error);
    }
}

if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
    const ctx = SillyTavern.getContext();
    if (ctx.eventSource) {
        ctx.eventSource.on(ctx.eventTypes?.APP_READY || 'app_ready', init);
    } else {
        init();
    }
} else {
    document.addEventListener('DOMContentLoaded', init);
}
log('personage script loaded');
