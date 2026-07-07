const BADGE_CLASS = 'persona_age_badge';
const METADATA_KEY = 'persona_age_override';

const AGE_PATTERNS = [
    /\b(\d+)\s*(?:years?\s*old|year)\b/i,
    /\b(\d+)\s*(?:yo|y\.?\s*o\.?)\b/i,
    /\b(\d+)-year-old\b/i,
];

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
        console.debug('Personage: resolveDefaultPersonaText error', e);
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

function getResolvedAge() {
    try {
        const ctx = SillyTavern.getContext();
        const override = ctx.chatMetadata?.[METADATA_KEY];
        if (typeof override === 'number' && override > 0 && override < 200) return { age: override, isOverride: true };
        if (typeof override === 'string') {
            const n = parseInt(override, 10);
            if (!isNaN(n) && n > 0 && n < 200) return { age: n, isOverride: true };
        }
        const desc = ctx.powerUserSettings?.persona_description || '';
        if (!desc) return null;
        const parsed = parseAgeFromDescription(desc);
        if (parsed) return { age: parsed, isOverride: false };
        return null;
    } catch (error) {
        console.debug('Personage: getResolvedAge error', error);
        return null;
    }
}

function replaceAgeInText(text, newAge) {
    for (const p of AGE_PATTERNS) {
        const m = text.match(p);
        if (m) {
            const age = parseInt(m[1], 10);
            if (!isNaN(age) && age > 0 && age < 200) {
                const numIdx = m.index + m[0].indexOf(m[1]);
                return text.slice(0, numIdx) + String(newAge) + text.slice(numIdx + m[1].length);
            }
        }
    }
    return text;
}

function onChatCompletionPromptReady(data) {
    try {
        const resolved = getResolvedAge();
        if (!resolved || !resolved.isOverride) return;
        const ctx = SillyTavern.getContext();
        const userName = ctx.name1;
        if (!userName) return;
        const defaultAge = findDefaultAgeInText(resolveDefaultPersonaText());
        if (!defaultAge || defaultAge === resolved.age) return;
        const personaMsg = data.chat.find(m =>
            m.role === 'system' &&
            typeof m.content === 'string' &&
            m.content.includes(userName) &&
            findDefaultAgeInText(m.content) === defaultAge
        );
        if (!personaMsg) return;
        const oldText = personaMsg.content;
        const newText = replaceAgeInText(oldText, resolved.age);
        if (newText === oldText) return;
        for (const m of data.chat) {
            if (typeof m.content === 'string' && m.content.includes(oldText)) {
                m.content = m.content.replace(oldText, newText);
            }
        }
    } catch (e) {
        console.debug('Personage: onChatCompletionPromptReady error', e);
    }
}

async function promptEditAge() {
    const ctx = SillyTavern.getContext();
    const current = getResolvedAge();
    const result = await ctx.Popup.show.input(
        'Edit Persona Age',
        'Enter age for this chat, or leave empty to reset to default.',
        current ? String(current.age) : '',
    );
    if (result === null) return;
    const trimmed = result.trim();
    if (!trimmed) {
        delete ctx.chatMetadata[METADATA_KEY];
        await ctx.saveMetadata();
        refreshAllBadges();
        return;
    }
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n <= 0 || n >= 200) {
        toastr.warning('Please enter a valid age (1-199).');
        return;
    }
    ctx.chatMetadata[METADATA_KEY] = n;
    await ctx.saveMetadata();
    refreshAllBadges();
}

function addAgeBadge(messageId) {
    const nameSpan = document.querySelector(`.mes[mesid="${messageId}"] .ch_name .name_text`);
    if (!nameSpan) return;
    const resolved = getResolvedAge();
    let badge = nameSpan.parentElement?.querySelector(`.${BADGE_CLASS}`);
    if (!resolved) {
        if (badge) badge.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.addEventListener('click', promptEditAge);
        nameSpan.insertAdjacentElement('afterend', badge);
    }
    badge.textContent = ` (${resolved.age}${resolved.isOverride ? '*' : ''})`;
    badge.dataset.isOverride = String(resolved.isOverride);
}

function refreshAllBadges() {
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
        setTimeout(refreshAllBadges, 500);
        console.debug('Personage: initialized');
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
