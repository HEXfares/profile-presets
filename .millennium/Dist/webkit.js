
const MILLENNIUM_IS_CLIENT_MODULE = false;
const pluginName = "profile-presets";

function InitializePlugins() {
    var e, n;
    (e = window.PLUGIN_LIST || (window.PLUGIN_LIST = {}))[pluginName] || (e[pluginName] = {});
    (n = window.MILLENNIUM_PLUGIN_SETTINGS_STORE || (window.MILLENNIUM_PLUGIN_SETTINGS_STORE = {}))[pluginName] || (n[pluginName] = {});
    window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS || (window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS = {});
}
InitializePlugins();

function callBackend(methodName, ...args) {
    const kwargs = {};
    if (args.length > 0) kwargs["arg0"] = args[0];
    if (args.length > 1) kwargs["arg1"] = args[1];
    return Millennium.callServerMethod(pluginName, methodName, kwargs)
        .then(r => r?.returnValue ?? r);
}

{

    const NAV_ITEM_ID = 'pp_nav_item';
    const PANEL_ID = 'pp_panel';

    let g_interceptedToken = null;

    const _origFetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const url = typeof args[0] === 'string' ? args[0]
                : (args[0] instanceof Request ? args[0].url : null);
            if (url && url.includes('access_token=')) {
                const m = url.match(/[?&]access_token=([^&]+)/);
                if (m) g_interceptedToken = decodeURIComponent(m[1]);
            }
        } catch (_) { }
        return _origFetch.apply(this, args);
    };

    const _origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
            if (url && url.includes('access_token=')) {
                const m = url.match(/[?&]access_token=([^&]+)/);
                if (m) g_interceptedToken = decodeURIComponent(m[1]);
            }
        } catch (_) { }
        return _origXHROpen.call(this, method, url, ...rest);
    };

    function getAccessToken() {
        return window.g_wapit || g_interceptedToken || null;
    }

    function getSteamId() {
        return (typeof g_steamID !== 'undefined' && g_steamID) ||
            window.location.pathname.match(/profiles\/(\d+)/)?.[1] || '';
    }

    function getSessionId() {
        if (typeof g_sessionID !== 'undefined' && g_sessionID) return g_sessionID;
        const inp = document.querySelector('input[name="sessionid"]');
        if (inp && inp.value) return inp.value;
        const m = document.cookie.match(/sessionid=([^;]+)/);
        return m ? m[1] : '';
    }

    function getProfileEdit(doc = document) {
        try {
            const el = doc.getElementById('profile_edit_config');
            if (!el) return null;
            const raw = el.dataset ? (el.dataset.profileEdit || el.getAttribute('data-profile-edit')) : el.getAttribute('data-profile-edit');
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    function getProfileBadges(doc = document) {
        try {
            const el = doc.getElementById('profile_edit_config');
            if (!el) return null;
            const raw = el.dataset ? (el.dataset.profileBadges || el.getAttribute('data-profile-badges')) : el.getAttribute('data-profile-badges');
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatDate(ts) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function encodeVarint(value) {
        const bytes = [];
        let n = BigInt(value);
        while (n > 127n) {
            bytes.push(Number((n & 0x7Fn) | 0x80n));
            n >>= 7n;
        }
        bytes.push(Number(n));
        return bytes;
    }

    function buildProtobuf(value) {
        const bytes = new Uint8Array([0x08, ...encodeVarint(value)]);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function encodeVarintField(fieldNumber, value) {
        const tag = (fieldNumber << 3) | 0;
        return [tag, ...encodeVarint(value)];
    }

    function encodeStringField(fieldNumber, str) {
        const tag = (fieldNumber << 3) | 2;
        const strBytes = Array.from(new TextEncoder().encode(String(str ?? '')));
        return [tag, ...encodeVarint(strBytes.length), ...strBytes];
    }

    function bytesToBase64(byteArray) {
        let binary = '';
        for (let i = 0; i < byteArray.length; i++) binary += String.fromCharCode(byteArray[i]);
        return btoa(binary);
    }

    function buildMultiFieldProtobuf(fields) {
        let bytes = [];
        fields.forEach(f => {
            if (f.type === 'string') bytes.push(...encodeStringField(f.num, f.value));
            else bytes.push(...encodeVarintField(f.num, BigInt(f.value)));
        });
        return bytesToBase64(new Uint8Array(bytes));
    }

    function resolveFavoriteBadge(favoriteBadge) {
        const communityItemId = favoriteBadge?.communityitemid;
        if (communityItemId && String(communityItemId) !== '0') {
            return { field: 1, value: communityItemId };
        }
        const badgeId = favoriteBadge?.badgeid;
        if (badgeId !== null && badgeId !== undefined && String(badgeId) !== '') {
            return { field: 2, value: badgeId };
        }
        return null;
    }

    function buildFavoriteBadgeProtobuf(favoriteBadge) {
        const resolved = resolveFavoriteBadge(favoriteBadge);
        if (!resolved) return null;
        return buildMultiFieldProtobuf([{ type: 'varint', num: resolved.field, value: resolved.value }]);
    }

    async function steamProtobufPost(endpoint, itemId) {
        const token = getAccessToken();
        if (!token) throw new Error('No access token. Navigate the profile page first.');
        const b64 = buildProtobuf(BigInt(itemId));
        const boundary = '----pp_boundary_' + Date.now();
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="input_protobuf_encoded"\r\n\r\n${b64}\r\n--${boundary}--`;
        const resp = await _origFetch(
            `https://api.steampowered.com/IPlayerService/${endpoint}/v1?access_token=${encodeURIComponent(token)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body
            }
        );
        if (!resp.ok) throw new Error(`${endpoint} HTTP ${resp.status}`);
        return resp;
    }

    async function steamApiPost(namespace, endpoint, base64ProtobufBody) {
        const token = getAccessToken();
        if (!token) throw new Error('No access token. Navigate the profile page first.');
        const boundary = '----pp_boundary_' + Date.now();
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="input_protobuf_encoded"\r\n\r\n${base64ProtobufBody}\r\n--${boundary}--`;
        const resp = await _origFetch(
            `https://api.steampowered.com/${namespace}/${endpoint}/v1?access_token=${encodeURIComponent(token)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body
            }
        );
        if (!resp.ok) throw new Error(`${endpoint} HTTP ${resp.status}`);
        return resp;
    }

    async function activateProfileModifier(appid, communityitemid, activate) {
        const b64 = buildMultiFieldProtobuf([
            { type: 'varint', num: 1, value: appid },
            { type: 'varint', num: 2, value: communityitemid },
            { type: 'varint', num: 3, value: activate ? 1 : 0 },
        ]);
        return steamApiPost('IQuestService', 'ActivateProfileModifierItem', b64);
    }

    async function setProfileTheme(themeId) {
        const b64 = buildMultiFieldProtobuf([{ type: 'string', num: 1, value: themeId }]);
        return steamApiPost('IPlayerService', 'SetProfileTheme', b64);
    }

    async function uploadAvatar(base64Data, steamId, sessionId) {
        const clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const byteStr = atob(clean);
        const arr = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
        const blob = new Blob([arr], { type: 'image/jpeg' });
        const fd = new FormData();
        fd.append('MAX_FILE_SIZE', '1048576');
        fd.append('type', 'player_avatar_image');
        fd.append('sId', steamId);
        fd.append('sessionid', sessionId);
        fd.append('doSub', '1');
        fd.append('json', '1');
        fd.append('avatar', blob, 'avatar.jpg');
        const resp = await _origFetch('https://steamcommunity.com/actions/FileUploader', { method: 'POST', body: fd });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch (_) {
            const reason = text.trim().replace(/^#/, '') || `HTTP ${resp.status}`;
            return {
                success: false,
                message: `Steam rejected the upload (${reason}) - this usually clears up after a short wait if you're applying several presets in a row.`
            };
        }
    }

    const HTML2CANVAS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

    let g_html2canvasLoading = null;

    function ensureHtml2Canvas() {
        if (typeof window.html2canvas === 'function') return Promise.resolve(true);
        if (g_html2canvasLoading) return g_html2canvasLoading;
        g_html2canvasLoading = new Promise(resolve => {
            const script = document.createElement('script');
            let timer;
            const finish = () => {
                clearTimeout(timer);
                script.onload = script.onerror = null;
                script.remove();
                resolve(typeof window.html2canvas === 'function');
            };
            script.onload = script.onerror = finish;
            timer = setTimeout(finish, 15000);
            script.src = HTML2CANVAS_SRC;
            document.head.appendChild(script);
        }).then(loaded => {
            g_html2canvasLoading = null;
            return loaded;
        });
        return g_html2canvasLoading;
    }

    function withTimeout(promise, timeoutMs, message) {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })]).finally(() => clearTimeout(timer));
    }

    function waitForAnySelector(doc, selectors, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            (function poll() {
                for (const sel of selectors) {
                    const el = doc.querySelector(sel);
                    if (el) { resolve(el); return; }
                }
                if (Date.now() - start > timeoutMs) { resolve(null); return; }
                setTimeout(poll, 150);
            })();
        });
    }

    const SHOT_W = 640, SHOT_H = 360;

    function cropToThumb(srcCanvas) {
        const out = document.createElement('canvas');
        out.width = SHOT_W; out.height = SHOT_H;
        const ctx = out.getContext('2d');
        const srcAspect = srcCanvas.width / srcCanvas.height;
        const dstAspect = SHOT_W / SHOT_H;
        let sx = 0, sy = 0, sw = srcCanvas.width, sh = srcCanvas.height;
        if (srcAspect > dstAspect) {
            sw = srcCanvas.height * dstAspect;
            sx = (srcCanvas.width - sw) / 2;
        } else {
            sh = srcCanvas.width / dstAspect;
            sy = 0;
        }
        ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, SHOT_W, SHOT_H);
        return out;
    }

    async function openProfileIframeAttempt(steamId, attemptTimeoutMs) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:0;left:-1300px;width:1200px;height:1600px;border:0;pointer-events:none;';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        const cleanup = () => iframe.remove();
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('Profile page load timed out')), attemptTimeoutMs);
                const finish = error => {
                    clearTimeout(timer);
                    iframe.onload = iframe.onerror = null;
                    error ? reject(error) : resolve();
                };
                iframe.onload = () => finish();
                iframe.onerror = () => finish(new Error('Profile page could not load'));
                iframe.src = location.origin + '/profiles/' + encodeURIComponent(steamId) + '?_ppcap=' + Date.now();
                document.body.appendChild(iframe);
            });
            const doc = iframe.contentDocument;
            if (!doc || doc.location.origin !== location.origin || /\/edit(?:\/|$)/.test(doc.location.pathname)) {
                throw new Error('Profile page is inaccessible or redirected to the editor');
            }
            const profile = await waitForAnySelector(doc, ['.profile_page'], 8000);
            if (!profile || !doc.querySelector('.profile_header, .profile_header_bg')) {
                throw new Error('Loaded page does not contain a Steam profile');
            }
            const target = doc.querySelector('.responsive_page_template_content') || profile;
            if (doc.fonts?.ready) await withTimeout(doc.fonts.ready, 8000, 'Profile fonts timed out');
            const images = Array.from(target.querySelectorAll('img')).filter(img => {
                const rect = img.getBoundingClientRect();
                return rect.top < 900 && rect.bottom > 0 && !!img.getAttribute('src');
            });
            await withTimeout(Promise.all(images.map(async img => {
                img.loading = 'eager';
                if (img.decode) await img.decode();
                else if (!img.complete) await new Promise((resolve, reject) => {
                    img.addEventListener('load', resolve, { once: true });
                    img.addEventListener('error', () => reject(new Error('Profile image failed to load')), { once: true });
                });
                if (!img.naturalWidth) throw new Error('Profile image failed to load');
            })), 12000, 'Profile images timed out');
            await new Promise(resolve => setTimeout(resolve, 300));
            if (target.getBoundingClientRect().width < 100) throw new Error('Profile has no renderable layout');
            return { target, cleanup };
        } catch (error) {
            cleanup();
            throw error;
        }
    }

    async function openProfileIframe(steamId) {
        try {
            return await openProfileIframeAttempt(steamId, 15000);
        } catch (error) {
            console.warn('[ProfilePresets] screenshot retry:', error.message);
            return openProfileIframeAttempt(steamId, 15000);
        }
    }

    async function fetchFreshEditDocumentAttempt(steamId, attemptTimeoutMs) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1200px;height:1600px;border:0;visibility:hidden;';
        iframe.src = `https://steamcommunity.com/profiles/${steamId}/edit/showcases?_ppcap=${Date.now()}`;
        document.body.appendChild(iframe);

        const cleanup = () => { try { iframe.remove(); } catch (_) { } };

        const loaded = await new Promise(resolve => {
            iframe.onload = () => resolve(true);
            iframe.onerror = () => resolve(false);
            setTimeout(() => resolve(false), attemptTimeoutMs);
        });
        if (!loaded) {
            console.warn('[ProfilePresets] fresh edit doc: iframe did not fire load within', attemptTimeoutMs, 'ms');
            cleanup();
            return null;
        }

        let doc;
        try {
            doc = iframe.contentDocument;
        } catch (e) {
            console.warn('[ProfilePresets] fresh edit doc: contentDocument access threw:', e && e.message);
            cleanup();
            return null;
        }
        if (!doc) {
            console.warn('[ProfilePresets] fresh edit doc: contentDocument is null/undefined after load');
            cleanup();
            return null;
        }

        await waitForAnySelector(doc, ['[name^="rgShowcaseConfig"]', 'select[name="profile_showcase[]"]', '#profile_edit_config'], 6000);
        await new Promise(r => setTimeout(r, 500));

        return { doc, cleanup };
    }

    async function fetchFreshEditDocument(steamId) {
        if (!steamId) return null;
        let result = await fetchFreshEditDocumentAttempt(steamId, 15000);
        if (result) return result;
        console.warn('[ProfilePresets] fresh edit doc: first iframe attempt failed, retrying once…');
        await new Promise(r => setTimeout(r, 500));
        result = await fetchFreshEditDocumentAttempt(steamId, 15000);
        if (!result) console.warn('[ProfilePresets] fresh edit doc: retry also failed, falling back to the live document');
        return result;
    }

    function normalizeCaptureColorFunctions(value, convertColor) {
        let result = '';
        let offset = 0;
        while (offset < value.length) {
            const character = value[offset];
            if (character === '"' || character === "'") {
                const start = offset++;
                while (offset < value.length) {
                    if (value[offset] === '\\') offset += 2;
                    else if (value[offset++] === character) break;
                }
                result += value.slice(start, offset);
                continue;
            }
            const match = value.slice(offset).match(/^([a-z][a-z0-9-]*)\(/i);
            if (!match) {
                result += value[offset++];
                continue;
            }
            const start = offset;
            offset += match[0].length;
            const innerStart = offset;
            let depth = 1;
            let quote = '';
            while (offset < value.length && depth) {
                const next = value[offset++];
                if (next === '\\') offset++;
                else if (quote) { if (next === quote) quote = ''; }
                else if (next === '"' || next === "'") quote = next;
                else if (next === '(') depth++;
                else if (next === ')') depth--;
            }
            if (depth) throw new Error('Unbalanced screenshot CSS function');
            const name = match[1].toLowerCase();
            const token = value.slice(start, offset);
            if (name === 'url') result += token;
            else if (['color', 'color-mix', 'oklab', 'oklch', 'lab', 'lch', 'hwb', 'light-dark', 'device-cmyk'].includes(name)) {
                result += convertColor(token);
            } else {
                result += match[0] + normalizeCaptureColorFunctions(value.slice(innerStart, offset - 1), convertColor) + ')';
            }
        }
        return result;
    }

    function splitCaptureBackgroundLayers(value) {
        const layers = [];
        let start = 0;
        let depth = 0;
        let quote = '';
        for (let index = 0; index < value.length; index++) {
            const character = value[index];
            if (character === '\\') index++;
            else if (quote) { if (character === quote) quote = ''; }
            else if (character === '"' || character === "'") quote = character;
            else if (character === '(') depth++;
            else if (character === ')') depth--;
            else if (character === ',' && depth === 0) {
                layers.push(value.slice(start, index).trim());
                start = index + 1;
            }
        }
        layers.push(value.slice(start).trim());
        return layers;
    }

    async function rasterizeCaptureGradient(clone, gradient, sizing) {
        let width = sizing.width;
        let height = sizing.height;
        const origin = sizing.origin;
        if (origin !== 'border-box') {
            width -= sizing.borderLeft + sizing.borderRight;
            height -= sizing.borderTop + sizing.borderBottom;
        }
        if (origin === 'content-box') {
            width -= sizing.paddingLeft + sizing.paddingRight;
            height -= sizing.paddingTop + sizing.paddingBottom;
        }
        if (sizing.attachment === 'fixed') {
            width = clone.defaultView.innerWidth;
            height = clone.defaultView.innerHeight;
        }
        const dimensions = sizing.size.trim().split(/\s+/);
        const resolveSize = (value, available) => {
            if (!value || ['auto', 'cover', 'contain'].includes(value)) return available;
            if (/^[\d.]+px$/.test(value)) return parseFloat(value);
            if (/^[\d.]+%$/.test(value)) return parseFloat(value) * available / 100;
            throw new Error('Screenshot gradient sizing is unsupported: ' + sizing.size);
        };
        width = Math.max(1, Math.ceil(resolveSize(dimensions[0], width)));
        height = Math.max(1, Math.ceil(resolveSize(dimensions[1], height)));
        if (width * height > 16777216 || width > 16384 || height > 16384) throw new Error('Profile gradient exceeds safe screenshot dimensions');
        const svg = clone.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', width + 1);
        svg.setAttribute('height', height + 1);
        const foreign = clone.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        foreign.setAttribute('width', width);
        foreign.setAttribute('height', height);
        const surface = clone.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        surface.style.cssText = 'width:100%;height:100%;';
        surface.style.backgroundImage = gradient;
        surface.style.color = sizing.color;
        surface.style.colorScheme = sizing.colorScheme;
        foreign.appendChild(surface);
        svg.appendChild(foreign);
        const probe = clone.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        probe.setAttribute('x', width);
        probe.setAttribute('y', height);
        probe.setAttribute('width', 1);
        probe.setAttribute('height', 1);
        const probeSurface = clone.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        probeSurface.style.cssText = 'width:1px;height:1px;background:rgb(255,0,0);';
        probe.appendChild(probeSurface);
        svg.appendChild(probe);
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
        await withTimeout(image.decode(), 5000, 'Profile gradient rendering timed out');
        const canvas = clone.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Profile gradient rendering is unavailable');
        context.drawImage(image, width, height, 1, 1, 0, 0, 1, 1);
        const probePixel = context.getImageData(0, 0, 1, 1).data;
        if (probePixel[0] < 250 || probePixel[1] > 5 || probePixel[2] > 5 || probePixel[3] < 250) throw new Error('Native profile gradient rendering is unavailable');
        canvas.width = width;
        canvas.height = height;
        context.drawImage(image, 0, 0);
        context.getImageData(0, 0, 1, 1);
        return 'url("' + canvas.toDataURL('image/png') + '")';
    }

    async function normalizeCaptureStyles(clone) {
        const canvas = clone.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        if (!context) throw new Error('Screenshot color conversion is unavailable');
        const cache = new Map();
        const gradientCache = new Map();
        const changes = [];
        const gradients = [];
        const modernColors = /(?:color|color-mix|oklab|oklch|lab|lch|hwb|light-dark|device-cmyk)\(/i;
        const diagnostics = { renderer: 'html2canvas 1.4.1', normalizedProperties: 0, rasterizedGradients: 0, samples: [], stylesheets: Array.from(clone.styleSheets, sheet => sheet.href || 'inline') };
        const convertColor = value => {
            if (cache.has(value)) return cache.get(value);
            context.fillStyle = '#010203';
            context.fillStyle = value;
            const first = context.fillStyle;
            context.fillStyle = '#040506';
            context.fillStyle = value;
            if (context.fillStyle !== first) throw new Error('Browser cannot convert screenshot color: ' + value);
            context.clearRect(0, 0, 1, 1);
            context.fillRect(0, 0, 1, 1);
            const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
            const converted = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
            cache.set(value, converted);
            return converted;
        };
        for (const element of clone.querySelectorAll('*')) {
            const computed = clone.defaultView.getComputedStyle(element);
            if (computed.backgroundImage.includes('-gradient(') && (modernColors.test(computed.backgroundImage)
                || /(?:repeating-(?:linear|radial|conic)|conic)-gradient\(|\bin\s+(?:srgb|srgb-linear|oklab|oklch|lab|lch|display-p3|xyz)/i.test(computed.backgroundImage))) {
                const layers = splitCaptureBackgroundLayers(computed.backgroundImage);
                const sizes = splitCaptureBackgroundLayers(computed.backgroundSize);
                const origins = splitCaptureBackgroundLayers(computed.backgroundOrigin);
                const attachments = splitCaptureBackgroundLayers(computed.backgroundAttachment);
                const sizing = { width: element.offsetWidth || element.getBoundingClientRect().width, height: element.offsetHeight || element.getBoundingClientRect().height, color: computed.color, colorScheme: computed.colorScheme };
                for (const edge of ['borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']) {
                    sizing[edge] = parseFloat(computed[edge + (edge.startsWith('border') ? 'Width' : '')]) || 0;
                }
                if (sizing.width && sizing.height && computed.display !== 'none') gradients.push({ element, layers, sizes, origins, attachments, sizing });
            }
            for (let index = 0; index < computed.length; index++) {
                const property = computed[index];
                if (property.startsWith('--')) continue;
                if (property === 'background-image' && gradients.at(-1)?.element === element) continue;
                const value = computed.getPropertyValue(property);
                if (!modernColors.test(value)) continue;
                const converted = normalizeCaptureColorFunctions(value, convertColor);
                if (converted === value) continue;
                changes.push({ element, property, converted });
                diagnostics.normalizedProperties++;
                if (diagnostics.samples.length < 30) diagnostics.samples.push({
                    element: element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (element.getAttribute('class') ? '.' + element.getAttribute('class').trim().replace(/\s+/g, '.') : ''),
                    property, value, converted
                });
            }
        }
        for (const { element, layers, sizes, origins, attachments, sizing } of gradients) {
            const rendered = [];
            for (let index = 0; index < layers.length; index++) {
                if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(layers[index])) {
                    const layerSizing = { ...sizing, size: sizes[index % sizes.length], origin: origins[index % origins.length], attachment: attachments[index % attachments.length] };
                    const key = JSON.stringify([layers[index], layerSizing]);
                    if (!gradientCache.has(key)) gradientCache.set(key, await rasterizeCaptureGradient(clone, layers[index], layerSizing));
                    rendered.push(gradientCache.get(key));
                    diagnostics.rasterizedGradients++;
                } else rendered.push(normalizeCaptureColorFunctions(layers[index], convertColor));
            }
            changes.push({ element, property: 'background-image', converted: rendered.join(', ') });
        }
        for (const { element, property, converted } of changes) element.style.setProperty(property, converted, 'important');
        window.__profilePresetsCaptureDiagnostics = diagnostics;
        if (diagnostics.normalizedProperties || diagnostics.rasterizedGradients) console.info('[ProfilePresets] screenshot CSS compatibility', diagnostics);
        for (const { element, property } of changes) {
            const value = clone.defaultView.getComputedStyle(element).getPropertyValue(property);
            if (normalizeCaptureColorFunctions(value, convertColor) !== value) {
                throw new Error('Screenshot CSS normalization did not apply: ' + property);
            }
        }
    }

    function isOptionalCaptureAsset(url) {
        return /(?:^|\.)steamstatic\.com$/i.test(url.hostname)
            && url.pathname === '/public/shared/images/community/levels_hexagons.png';
    }

    async function verifyCaptureAssets(target) {
        const doc = target.ownerDocument;
        const view = doc.defaultView;
        const bounds = target.getBoundingClientRect();
        const elements = [target, ...target.querySelectorAll('*')];
        for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) elements.push(ancestor);
        const sources = new Set();
        const assets = { replacements: new Map(), omitted: new Set(), warnings: [] };
        for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= bounds.top || rect.top >= bounds.top + 900 || !rect.width || !rect.height) continue;
            const computed = view.getComputedStyle(element);
            if (computed.display === 'none' || computed.visibility === 'hidden') continue;
            if (element.tagName === 'IMG' && (element.currentSrc || element.src)) sources.add(element.currentSrc || element.src);
            for (const match of computed.backgroundImage.matchAll(/url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)]*))\s*\)/g)) {
                sources.add(match[1] || match[2] || match[3].trim());
            }
        }
        const queue = Array.from(sources);
        let failure = null;
        const load = async source => {
            const url = new URL(source, doc.baseURI);
            const image = new Image();
            if (['http:', 'https:'].includes(url.protocol)) image.crossOrigin = 'anonymous';
            image.src = url.href;
            try {
                await withTimeout(image.decode(), 6000, 'Image loading timed out');
                if (!image.naturalWidth) throw new Error('Empty image');
                const probe = doc.createElement('canvas');
                probe.width = probe.height = 1;
                const context = probe.getContext('2d');
                context.drawImage(image, 0, 0, 1, 1);
                context.getImageData(0, 0, 1, 1);
            } catch (browserError) {
                if (isOptionalCaptureAsset(url)) {
                    assets.omitted.add(url.href);
                    assets.warnings.push('Steam level decoration unavailable');
                    console.warn('[ProfilePresets] optional screenshot texture omitted:', url.href, browserError.message);
                    return;
                }
                let response = await callBackend('FetchScreenshotAsset', url.href);
                for (let attempt = 0; attempt < 2 && typeof response === 'string'; attempt++) response = JSON.parse(response);
                if (!response?.success || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(response.mime)
                    || typeof response.base64 !== 'string' || !response.base64) {
                    throw new Error('Essential profile image could not be loaded: ' + url.origin + url.pathname + ' (' + (response?.error || browserError.message) + ')');
                }
                const dataUrl = 'data:' + response.mime + ';base64,' + response.base64;
                const recovered = new Image();
                recovered.src = dataUrl;
                await withTimeout(recovered.decode(), 5000, 'Recovered profile image validation timed out');
                if (!recovered.naturalWidth) throw new Error('Recovered profile image is invalid');
                assets.replacements.set(url.href, dataUrl);
                console.info('[ProfilePresets] screenshot image recovered through native HTTP:', url.origin + url.pathname);
            }
        };
        const worker = async () => {
            while (queue.length && !failure) {
                try { await load(queue.shift()); }
                catch (error) { failure = error; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
        if (failure) throw failure;
        return assets;
    }

    async function applyCaptureAssets(clone, assets) {
        const pending = [];
        for (const element of clone.querySelectorAll('*')) {
            if (element.tagName === 'IMG' && (element.currentSrc || element.src)) {
                const source = new URL(element.currentSrc || element.src, clone.baseURI).href;
                if (assets.replacements.has(source)) {
                    element.removeAttribute('srcset');
                    element.src = assets.replacements.get(source);
                    pending.push(element.decode());
                } else if (assets.omitted.has(source)) element.style.setProperty('visibility', 'hidden', 'important');
            }
            const background = clone.defaultView.getComputedStyle(element).backgroundImage;
            const updated = background.replace(/url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)]*))\s*\)/g, (token, doubleQuoted, singleQuoted, unquoted) => {
                const source = new URL(doubleQuoted || singleQuoted || unquoted.trim(), clone.baseURI).href;
                if (assets.omitted.has(source)) return 'none';
                if (assets.replacements.has(source)) return 'url("' + assets.replacements.get(source) + '")';
                return token;
            });
            if (updated !== background) element.style.setProperty('background-image', updated, 'important');
        }
        await withTimeout(Promise.all(pending), 6000, 'Cloned profile images timed out');
    }

    async function captureFrame(target) {
        const assets = await verifyCaptureAssets(target);
        const canvas = await window.html2canvas(target, {
            useCORS: true,
            allowTaint: false,
            backgroundColor: null,
            scale: 1,
            logging: false,
            imageTimeout: 10000,
            onclone: async clone => {
                await applyCaptureAssets(clone, assets);
                await normalizeCaptureStyles(clone);
                window.__profilePresetsCaptureDiagnostics.optionalAssets = Array.from(assets.omitted);
                window.__profilePresetsCaptureDiagnostics.recoveredAssets = Array.from(assets.replacements.keys());
            },
            width: 1200,
            height: Math.min(target.scrollHeight || 900, 900)
        });
        canvas.ppCaptureWarnings = assets.warnings;
        return canvas;
    }

    async function captureProfileScreenshot(steamId) {
        if (!steamId) throw new Error('Steam account is unavailable');
        if (!await ensureHtml2Canvas()) throw new Error('Screenshot renderer could not load. Check the connection to cdnjs.cloudflare.com and retry.');
        const { target, cleanup } = await openProfileIframe(steamId);
        try {
            const raw = await withTimeout(captureFrame(target), 60000, 'Profile rendering timed out');
            if (!raw.width || !raw.height) throw new Error('Profile rendering returned an empty image');
            const thumb = cropToThumb(raw);
            const pixels = thumb.getContext('2d').getImageData(0, 0, SHOT_W, SHOT_H).data;
            let varied = false;
            for (let i = 4; i < pixels.length; i += 4) {
                if (Math.abs(pixels[i] - pixels[0]) + Math.abs(pixels[i + 1] - pixels[1]) + Math.abs(pixels[i + 2] - pixels[2]) > 30) {
                    varied = true;
                    break;
                }
            }
            if (!varied) throw new Error('Profile rendering returned a blank image');
            const dataUrl = thumb.toDataURL('image/jpeg', 0.72);
            if (!dataUrl.startsWith('data:image/jpeg;base64,/9j/')) throw new Error('Invalid screenshot encoding');
            const image = new Image();
            image.src = dataUrl;
            await withTimeout(image.decode(), 5000, 'Screenshot validation timed out');
            if (image.naturalWidth !== SHOT_W || image.naturalHeight !== SHOT_H) throw new Error('Invalid screenshot dimensions');
            return { base64: dataUrl.split(',')[1], mime: 'image/jpeg', warnings: raw.ppCaptureWarnings || [] };
        } finally {
            cleanup();
        }
    }

    async function fetchEquippedItems() {
        const token = getAccessToken();
        const steamId = getSteamId();
        if (!token || !steamId) return null;

        try {
            const resp = await _origFetch(
                `https://api.steampowered.com/IPlayerService/GetProfileItemsEquipped/v1` +
                `?steamid=${encodeURIComponent(steamId)}&access_token=${encodeURIComponent(token)}`
            );
            if (!resp.ok) return null;
            const data = await resp.json();
            const r = data?.response || {};

            const cid = obj => String(
                obj?.communityitemid || obj?.CommunityItemID || obj?.community_item_id || 0
            );
            const appidOf = obj => Number(obj?.appid || obj?.AppID || 0);

            const goldenProfileAppId = String(appidOf(r.profile_modifier) || 0);
            const goldenProfileItemId = cid(r.profile_modifier);

            return {
                backgroundItemId: cid(r.profile_background),
                miniProfileItemId: cid(r.mini_profile_background ?? r.miniprofile_background),
                avatarFrameItemId: cid(r.avatar_frame),
                animatedAvatarId: cid(r.animated_avatar),
                goldenProfileAppId,
                goldenProfileItemId
            };
        } catch (_) {
            return null;
        }
    }

    function captureBasicProfile(doc = document) {
        const profileEdit = getProfileEdit(doc);
        if (!profileEdit) return null;
        const badges = getProfileBadges(doc);
        const steamId = getSteamId();

        const showcases = [];
        doc.querySelectorAll('select[name="profile_showcase[]"]').forEach((sel, i) => {
            const type = sel.value;
            const purchaseInput = doc.getElementById(`showcase_${i}_purchaseid`);
            const purchaseid = purchaseInput ? purchaseInput.value : '0';
            const inputs = {};
            doc.querySelectorAll(`[name*="rgShowcaseConfig[${type}_${purchaseid}]"]`)
                .forEach(inp => { inputs[inp.name] = inp.value; });
            const styleField = doc.querySelector(`[name="profile_showcase_style_${type}_${purchaseid}"]`);
            if (styleField) inputs[styleField.name] = styleField.value;
            showcases.push({ slot: String(i), type, purchaseid, inputs });
        });

        const allShowcaseConfig = {};
        doc.querySelectorAll('[name^="rgShowcaseConfig"], [name^="profile_showcase_style"]').forEach(inp => {
            allShowcaseConfig[inp.name] = inp.value;
        });

        const gameCollectorOrder = [];
        doc.querySelectorAll('.showcase_gamecollector_game').forEach(el => {
            const link = el.querySelector('a[href*="/app/"]');
            const img = el.querySelector('img[src*="/apps/"]');
            let appid = null;
            if (link) { const m = link.href.match(/\/app\/(\d+)/); if (m) appid = m[1]; }
            if (!appid && img) { const m = img.src.match(/\/apps\/(\d+)\//); if (m) appid = m[1]; }
            if (appid) gameCollectorOrder.push(appid);
        });

        const completionistOrder = [];
        doc.querySelectorAll('.showcase_achievementscompletionist_game').forEach(el => {
            const link = el.querySelector('a[href*="/app/"]');
            const img = el.querySelector('img[src*="/apps/"]');
            let appid = null;
            if (link) { const m = link.href.match(/\/app\/(\d+)/); if (m) appid = m[1]; }
            if (!appid && img) { const m = img.src.match(/\/apps\/(\d+)\//); if (m) appid = m[1]; }
            if (appid) completionistOrder.push(appid);
        });

        const activeTheme = profileEdit.ActiveTheme || profileEdit.activeTheme || {};
        const themeId = activeTheme.theme_id || activeTheme.themeId || '';

        return {
            savedAt: Math.floor(Date.now() / 1000),
            steamId,
            personaName: profileEdit.strPersonaName || '',
            theme: themeId,
            avatarHash: profileEdit.strAvatarHash || '',
            hasLocalAvatar: false,
            avatarType: 'uploaded',
            backgroundItemId: '0',
            miniProfileItemId: '0',
            avatarFrameItemId: '0',
            animatedAvatarId: '0',
            goldenProfileAppId: '0',
            goldenProfileItemId: '0',
            favoriteBadge: badges?.FavoriteBadge || { badgeid: '', communityitemid: '' },
            showcases,
            allShowcaseConfig,
            gameCollectorOrder,
            completionistOrder
        };
    }

    const APPLY_STEP_LABELS = {
        gameProfile: { name: 'Game Profile', ok: 'Switched game profile', fail: 'Failed to switch game profile' },
        avatar: { name: 'Avatar', ok: 'Switched avatar', fail: 'Failed to switch avatar' },
        animatedAvatar: { name: 'Animated Avatar', ok: 'Switched animated avatar', fail: 'Failed to switch animated avatar' },
        avatarFrame: { name: 'Avatar Frame', ok: 'Switched avatar frame', fail: 'Failed to switch avatar frame' },
        background: { name: 'Profile Background', ok: 'Switched profile background', fail: 'Failed to switch profile background' },
        miniProfile: { name: 'Mini Profile', ok: 'Switched mini profile background', fail: 'Failed to switch mini profile background' },
        theme: { name: 'Theme', ok: 'Switched theme', fail: 'Failed to switch theme' },
        badge: { name: 'Featured Badge', ok: 'Switched featured badge', fail: 'Failed to switch featured badge' },
        showcases: { name: 'Showcases', ok: 'Updated showcases', fail: 'Failed to update showcases' },
    };

    function createApplyLogger() {
        const state = { presetName: null, startedAt: 0, entries: [] };

        function start(presetName) {
            state.presetName = presetName;
            state.startedAt = performance.now();
            state.entries = [];
            console.log(`%c[Apply Started]${presetName ? ' — ' + presetName : ''}`, 'color:#4c9ed9;font-weight:bold');
        }

        function step(key) {
            const labels = APPLY_STEP_LABELS[key] || { name: key, ok: key, fail: 'Failed: ' + key };
            const startedAt = performance.now();
            return {
                ok() {
                    const durationMs = Math.round(performance.now() - startedAt);
                    state.entries.push({
                        timestamp: new Date().toISOString(), step: labels.name,
                        success: true, error: null, durationMs,
                    });
                    console.log(`%c✓ ${labels.ok}`, 'color:#27ae60', `(${durationMs}ms)`);
                },
                fail(err) {
                    const durationMs = Math.round(performance.now() - startedAt);
                    const message = err?.message || String(err);
                    state.entries.push({
                        timestamp: new Date().toISOString(), step: labels.name,
                        success: false, error: message, durationMs,
                    });
                    console.log(`%c✗ ${labels.fail}`, 'color:#c0392b');
                    console.log(`  Error: ${message}`);
                },
            };
        }

        function finish() {
            const durationMs = Math.round(performance.now() - state.startedAt);
            const successful = state.entries.filter(e => e.success);
            const failed = state.entries.filter(e => !e.success);
            const overall = failed.length === 0
                ? 'SUCCESS'
                : (successful.length === 0 ? 'FAILED' : 'SUCCESS WITH ERRORS');

            console.log('==========================');
            console.log('Preset Apply Summary');
            console.log('==========================');
            console.log('');
            console.log(`Successful: ${successful.length}`);
            console.log(`Failed: ${failed.length}`);
            if (failed.length) {
                console.log('');
                console.log('Failed Steps:');
                failed.forEach(f => {
                    console.log(`- ${f.step}`);
                    console.log(`  Error: ${f.error}`);
                });
            }
            console.log('');
            console.log(`Duration: ${durationMs}ms`);
            console.log('');
            console.log('Overall Result:');
            console.log(overall);

            return {
                presetName: state.presetName, entries: state.entries,
                durationMs, successful: successful.length, failed: failed.length, overall,
            };
        }

        return { start, step, finish };
    }

    async function applyPreset(preset, options, onProgress) {
        const steamId = getSteamId();
        const sessionId = getSessionId();
        const baseUrl = `https://steamcommunity.com/profiles/${steamId}/edit`;
        const errors = [];
        let step = 0;

        function progress(msg) { onProgress && onProgress(++step, msg); }

        const applyLogger = createApplyLogger();
        applyLogger.start(preset?.name);

        const freshEdit = await fetchFreshEditDocument(steamId);
        const freshDoc = freshEdit?.doc || null;

        const hasGoldenProfile = !!(
            preset.goldenProfileAppId && preset.goldenProfileAppId !== '0' &&
            preset.goldenProfileItemId && preset.goldenProfileItemId !== '0'
        );
        if (options.gameProfile && hasGoldenProfile) {
            const log = applyLogger.step('gameProfile');
            try {
                await activateProfileModifier(preset.goldenProfileAppId, preset.goldenProfileItemId, true);
                progress('Game profile activated');
                log.ok();
            } catch (e) {
                errors.push('Game profile: ' + e.message);
                log.fail(e);
            }
        }

        if (options.avatar) {
            const isAnimated = preset.avatarType === 'community_item' && preset.animatedAvatarId && preset.animatedAvatarId !== '0';
            const hasUploaded = !isAnimated && !!preset.avatarBase64;
            if (isAnimated || hasUploaded) {
                const log = applyLogger.step(isAnimated ? 'animatedAvatar' : 'avatar');
                try {
                    if (isAnimated) {
                        await steamProtobufPost('SetAnimatedAvatar', preset.animatedAvatarId);
                        progress('Animated avatar applied');
                        log.ok();
                    } else {
                        const liveAvatarHash = getProfileEdit(freshDoc || document)?.strAvatarHash;
                        if (preset.avatarHash && liveAvatarHash && liveAvatarHash === preset.avatarHash) {
                            progress('Avatar already up to date - upload skipped');
                            log.ok();
                        } else {
                            let result = await uploadAvatar(preset.avatarBase64, steamId, sessionId);
                            if (!result.success) {
                                await new Promise(r => setTimeout(r, 1500));
                                result = await uploadAvatar(preset.avatarBase64, steamId, sessionId);
                            }
                            if (result.success) { progress('Avatar uploaded'); log.ok(); }
                            else {
                                const msg = result.message || 'Upload rejected';
                                errors.push('Avatar: ' + msg);
                                log.fail(new Error(msg));
                            }
                        }
                    }
                } catch (e) { errors.push('Avatar: ' + e.message); log.fail(e); }
            }
        }

        if (options.avatarFrame) {
            const log = applyLogger.step('avatarFrame');
            try {
                await steamProtobufPost('SetAvatarFrame', preset.avatarFrameItemId || '0');
                progress('Avatar frame applied');
                log.ok();
            } catch (e) { errors.push('Avatar frame: ' + e.message); log.fail(e); }
        }

        if (options.background) {
            const log = applyLogger.step('background');
            try {
                await steamProtobufPost('SetProfileBackground', preset.backgroundItemId || '0');
                progress('Profile background applied');
                log.ok();
            } catch (e) { errors.push('Background: ' + e.message); log.fail(e); }
        }

        if (options.miniProfile) {
            const log = applyLogger.step('miniProfile');
            try {
                await steamProtobufPost('SetMiniProfileBackground', preset.miniProfileItemId || '0');
                progress('Mini profile applied');
                log.ok();
            } catch (e) { errors.push('Mini profile: ' + e.message); log.fail(e); }
        }

        if (options.theme && !hasGoldenProfile) {
            const log = applyLogger.step('theme');
            try {
                await setProfileTheme(preset.theme || 'Default');
                progress('Theme applied');
                log.ok();
            } catch (e) { errors.push('Theme: ' + e.message); log.fail(e); }
        }

        if (options.badge) {
            const favoriteBadgeProtobuf = buildFavoriteBadgeProtobuf(preset.favoriteBadge);
            if (favoriteBadgeProtobuf) {
                const log = applyLogger.step('badge');
                try {
                    await steamApiPost('IPlayerService', 'SetFavoriteBadge', favoriteBadgeProtobuf);
                    progress('Featured badge applied');
                    log.ok();
                } catch (e) { errors.push('Badge: ' + e.message); log.fail(e); }
            }
        }

        if (options.showcases) {
            const log = applyLogger.step('showcases');
            try {
                const showcases = Array.isArray(preset.showcases) ? preset.showcases : [];
                const liveHideAwards = getProfileEdit(freshDoc || document)?.ProfilePreferences?.hide_profile_awards;
                const params = new URLSearchParams();
                params.append('sessionID', sessionId);
                params.append('type', 'showcases');
                params.append('json', '1');
                if (liveHideAwards !== null && liveHideAwards !== undefined) {
                    params.append('hide_profile_awards', String(liveHideAwards));
                }
                showcases.forEach(s => {
                    params.append('profile_showcase[]', s.type);
                    params.append('profile_showcase_purchaseid[]', s.purchaseid);
                });
                const sortEntries = (entries) => entries.sort((a, b) => {
                    const ai = a[0].match(/\]\[(\d+)\]/);
                    const bi = b[0].match(/\]\[(\d+)\]/);
                    const an = ai ? parseInt(ai[1], 10) : 0;
                    const bn = bi ? parseInt(bi[1], 10) : 0;
                    if (an !== bn) return an - bn;
                    return a[0].localeCompare(b[0]);
                });
                if (preset.allShowcaseConfig && Object.keys(preset.allShowcaseConfig).length) {
                    sortEntries(Object.entries(preset.allShowcaseConfig)).forEach(([k, v]) => params.append(k, v));
                } else {
                    showcases.forEach(s => {
                        sortEntries(Object.entries(s.inputs || {})).forEach(([k, v]) => params.append(k, v));
                    });
                }
                await _origFetch(`${baseUrl}/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString()
                });

                if (Array.isArray(preset.gameCollectorOrder) && preset.gameCollectorOrder.length) {
                    for (let slot = 0; slot < preset.gameCollectorOrder.length; slot++) {
                        const p = new URLSearchParams();
                        p.append('appid', preset.gameCollectorOrder[slot]);
                        p.append('customization_type', '2');
                        p.append('purchaseid', '0');
                        p.append('slot', String(slot));
                        p.append('sessionid', sessionId);
                        await _origFetch(`https://steamcommunity.com/profiles/${steamId}/ajaxsetshowcaseconfig`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: p.toString()
                        });
                    }
                }

                if (Array.isArray(preset.completionistOrder) && preset.completionistOrder.length) {
                    for (let slot = 0; slot < preset.completionistOrder.length; slot++) {
                        const p = new URLSearchParams();
                        p.append('appid', preset.completionistOrder[slot]);
                        p.append('customization_type', '23');
                        p.append('purchaseid', '0');
                        p.append('slot', String(slot));
                        p.append('sessionid', sessionId);
                        await _origFetch(`https://steamcommunity.com/profiles/${steamId}/ajaxsetshowcaseconfig`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: p.toString()
                        });
                    }
                }

                progress('Showcases applied');
                log.ok();
            } catch (e) { errors.push('Showcases: ' + e.message); log.fail(e); }
        }

        const applyLog = applyLogger.finish();

        try {
            await callBackend('LogApplySummary', JSON.stringify(applyLog), steamId);
        } catch (e) {
            console.log('%c[ApplyLogger] Failed to bridge summary to native Logs page: ' + e.message, 'color:#c0392b');
        }

        if (freshEdit) freshEdit.cleanup();

        return { success: errors.length === 0, errors, log: applyLog };
    }

    function showToast(msg, type = 'info', duration = 3500) {
        const t = document.createElement('div');
        t.className = 'pp_toast pp_toast_' + type;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => {
            t.style.opacity = '0';
            t.style.transition = 'opacity 0.3s';
            setTimeout(() => t.remove(), 300);
        }, duration);
    }

    function injectStyles() {
        if (document.getElementById('pp_styles')) return;
        const s = document.createElement('style');
        s.id = 'pp_styles';
        s.textContent = `
        #pp_nav_item { cursor:pointer; }
        #pp_nav_item.pp_active { font-weight:600; }
        #pp_panel { display:none; box-sizing:border-box; flex:1 1 0%; width:100%; min-width:0; max-width:100%; padding:0 16px 16px; color:inherit; font:inherit; font-size:12px; container-type:inline-size; }
        #pp_panel.pp_visible { display:block; }
        #pp_panel *, #pp_panel *::before, #pp_panel *::after { box-sizing:border-box; }
        #pp_panel .pp_header { padding:16px 0 12px; }
        #pp_panel .pp_header h2 { color:inherit; font-size:18px; line-height:1.3; font-weight:600; margin:0 0 4px; }
        #pp_panel .pp_header p { margin:0; font-size:12px; line-height:1.5; opacity:.75; }
        #pp_panel .pp_save { margin-bottom:12px; }
        #pp_panel .pp_lbl { display:block; font-size:11px; font-weight:600; margin-bottom:6px; }
        #pp_panel .pp_row { display:flex; flex-wrap:wrap; gap:8px; align-items:stretch; }
        #pp_panel .pp_input { flex:1 1 160px; min-width:0; width:100%; min-height:32px; padding:6px 9px; font:inherit; color:inherit; background:rgba(127,127,127,.06); border:1px solid rgba(127,127,127,.3); border-radius:4px; }
        #pp_panel .pp_input::placeholder { color:inherit; opacity:.55; }
        #pp_panel .pp_btn, #pp_panel .pp_icon_btn { font:inherit; color:inherit; background:rgba(127,127,127,.1); border:1px solid transparent; border-radius:4px; cursor:pointer; }
        #pp_panel .pp_btn { min-height:32px; padding:6px 12px; font-weight:600; }
        #pp_panel .pp_btn:hover, #pp_panel .pp_icon_btn:hover { background:rgba(127,127,127,.2); }
        #pp_panel button:disabled { opacity:.5; cursor:wait; }
        #pp_panel :is(button,input,.pp_shot_wrap):focus-visible { outline:2px solid currentColor; outline-offset:2px; }
        #pp_panel #pp_save_status { min-height:18px; margin-top:4px; font-size:11px; line-height:1.5; overflow-wrap:anywhere; }
        #pp_panel .pp_gallery_heading { color:inherit; font-size:12px; font-weight:600; margin:0 0 8px; }
        #pp_panel .pp_grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,max(240px,calc((100% - 24px)/3))),1fr)); gap:12px; align-items:stretch; }
        #pp_panel .pp_grid > div:not(.pp_card) { grid-column:1/-1; min-width:0; overflow-wrap:anywhere; }
        @supports (container-type:inline-size) {
            #pp_panel .pp_grid { grid-template-columns:minmax(0,1fr); }
            @container (min-width:512px) { #pp_panel .pp_grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
            @container (min-width:960px) { #pp_panel .pp_grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
        }
        #pp_panel .pp_card { display:flex; flex-direction:column; min-width:0; overflow:hidden; border:1px solid rgba(127,127,127,.18); border-radius:6px; background:rgba(127,127,127,.035); }
        #pp_panel .pp_card:hover { border-color:rgba(127,127,127,.4); }
        #pp_panel .pp_shot_wrap { cursor:pointer; min-width:0; flex:1; }
        #pp_panel .pp_shot_img, #pp_panel .pp_missing_shot { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:rgba(127,127,127,.1); }
        #pp_panel .pp_missing_shot { display:flex; align-items:center; justify-content:center; font-size:11px; opacity:.7; }
        #pp_panel .pp_shot_overlay { padding:9px 10px 4px; min-width:0; }
        #pp_panel .pp_shot_name { font-size:13px; line-height:1.4; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        #pp_panel .pp_shot_meta { font-size:10.5px; line-height:1.5; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; min-height:16px; }
        #pp_panel .pp_shot_actions { display:flex; align-items:center; gap:6px; padding:3px 10px 9px; }
        #pp_panel .pp_icon_btn { min-height:28px; font-size:11px; padding:4px 8px; }
        #pp_panel .pp_delete { margin-inline-start:auto; background:transparent; }
        #pp_panel .pp_empty { grid-column:1/-1; padding:24px 8px; text-align:center; opacity:.75; }
        #pp_panel .pp_progress { background:rgba(127,127,127,.06); border-radius:4px; padding:10px; margin-bottom:12px; }
        #pp_panel .pp_bar_track { height:3px; background:rgba(127,127,127,.2); margin:8px 0; }
        #pp_panel .pp_bar_fill { height:100%; background:currentColor; }
        #pp_panel .pp_bar_msg { font-size:11px; }
        .pp_toast { position:fixed; bottom:24px; right:24px; background:Canvas; color:CanvasText; border:1px solid currentColor; border-radius:5px; padding:10px 12px; font:12px sans-serif; z-index:99999; max-width:min(420px,calc(100vw - 48px)); overflow-wrap:anywhere; }
    `;
        document.head.appendChild(s);
    }

    let saveInProgress = false;

    async function savePreset(name, statusEl) {
        if (saveInProgress) return false;
        saveInProgress = true;
        function status(msg) {
            if (statusEl) statusEl.textContent = msg;
        }
        try {

            status('Refreshing profile data…');
            const steamId = getSteamId();
            const freshEdit = await fetchFreshEditDocument(steamId);

            let preset;
            try {
                preset = captureBasicProfile(freshEdit?.doc || document);
            } finally {
                freshEdit?.cleanup();
            }
            if (!preset) throw new Error('Could not read profile data');
            preset.name = name;

            status('Fetching equipment…');
            const equipped = await fetchEquippedItems();
            if (equipped) {
                preset.backgroundItemId = equipped.backgroundItemId;
                preset.miniProfileItemId = equipped.miniProfileItemId;
                preset.avatarFrameItemId = equipped.avatarFrameItemId;
                preset.animatedAvatarId = equipped.animatedAvatarId;
                preset.goldenProfileAppId = equipped.goldenProfileAppId;
                preset.goldenProfileItemId = equipped.goldenProfileItemId;

                if (equipped.animatedAvatarId && equipped.animatedAvatarId !== '0') {
                    preset.avatarType = 'community_item';
                } else {
                    preset.avatarType = 'uploaded';
                }
            } else {
                showToast('Warning: could not fetch equipment (no token yet). Equipment items may not be saved.', 'error', 5000);
            }

            if (preset.avatarType !== 'community_item') {
                status('Downloading avatar…');
                try {
                    if (preset.avatarHash) {
                        const resp = await _origFetch(`https://avatars.fastly.steamstatic.com/${preset.avatarHash}_full.jpg`);
                        if (resp.ok) {
                            const blob = await resp.blob();
                            preset.avatarBase64 = await new Promise(resolve => {
                                const r = new FileReader();
                                r.onload = () => resolve(r.result.split(',')[1]);
                                r.readAsDataURL(blob);
                            });
                        }
                    }
                } catch (_) { }
            }

            status('Capturing profile screenshot…');
            let screenshotError = '';
            let screenshotWarning = '';
            try {
                const shot = await captureProfileScreenshot(steamId);
                preset.screenshotBase64 = shot.base64;
                preset.screenshotMime = shot.mime;
                if (shot.warnings?.length) screenshotWarning = ' Steam level decoration was unavailable.';
            } catch (error) {
                screenshotError = error.message;
                console.error('[ProfilePresets] screenshot:', error);
            }

            if (getSteamId() !== steamId) throw new Error('Steam account changed during capture. Please save again.');
            preset.screenshotError = screenshotError || undefined;
            status('Saving...');
            try {
                let raw = await callBackend('SavePreset', JSON.stringify(preset), steamId);
                if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                if (raw.success) {
                    const warning = screenshotError || raw.screenshotError;
                    const message = warning ? 'Preset saved. Screenshot failed: ' + warning : 'Preset saved with profile screenshot.' + screenshotWarning;
                    status(message);
                    showToast(message, warning ? 'error' : 'success', warning ? 10000 : 3000);
                    await loadAndRenderPresets();
                    return true;
                } else {
                    throw new Error('Save failed: ' + raw.error);
                }
            } catch (e) { throw e; }
        } catch (error) {
            status(error.message);
            showToast(error.message, 'error', 7000);
            return false;
        } finally {
            saveInProgress = false;
        }
    }

    async function loadAndRenderPresets() {
        const grid = document.getElementById('pp_grid');
        if (!grid) return;
        grid.innerHTML = '<div style="color:inherit;padding:20px;text-align:center;font-size:12px">Loading…</div>';

        try {
            const steamId = getSteamId();
            let raw = await callBackend('ListPresets', steamId);
            if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
            if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
            const presets = Array.isArray(raw) ? raw : [];

            if (presets.length === 0) {
                grid.innerHTML = `<div class="pp_empty"><p>No presets saved yet.<br>Save your current profile above.</p></div>`;
                return;
            }

            presets.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
            grid.innerHTML = '';

            presets.forEach(p => {
                const card = document.createElement('div');
                card.className = 'pp_card';
                card.innerHTML = `
                    <div class="pp_shot_wrap" tabindex="0" role="button" aria-label="Apply ${escapeHtml(p.name)}" title="Apply this preset">
                        <div class="pp_missing_shot">Screenshot unavailable</div>
                        <div class="pp_shot_overlay">
                            <div class="pp_shot_name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
                            <div class="pp_shot_meta">${escapeHtml(p.personaName || '')} &middot; ${formatDate(p.savedAt)}</div>
                        </div>
                    </div>
                    <div class="pp_shot_actions">
                        <button class="pp_icon_btn pp_update" title="Update preset">Update</button>
                        <button class="pp_icon_btn pp_delete" title="Delete preset">Delete</button>
                    </div>`;
                if (p.screenshotBase64 && ['image/jpeg', 'image/png'].includes(p.screenshotMime || 'image/jpeg')) {
                    const image = new Image();
                    image.className = 'pp_shot_img';
                    image.alt = 'Profile preview for ' + p.name;
                    image.onload = () => card.querySelector('.pp_missing_shot')?.replaceWith(image);
                    image.src = 'data:' + (p.screenshotMime || 'image/jpeg') + ';base64,' + p.screenshotBase64;
                }

                const applyPresetFlow = async () => {
                    if (!confirm(`Apply preset "${p.name}"?`)) return;
                    try {
                        let raw = await callBackend('LoadPreset', p.name, getSteamId());
                        if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                        if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                        if (!raw.success) { showToast('Load failed: ' + raw.error, 'error'); return; }
                        await runApply(raw.preset, {
                            gameProfile: true,
                            avatar: true,
                            avatarFrame: true,
                            background: true,
                            miniProfile: true,
                            theme: true,
                            badge: true,
                            showcases: true,
                        });
                    } catch (e) { showToast('Error: ' + e.message, 'error'); }
                };

                const wrap = card.querySelector('.pp_shot_wrap');
                wrap.addEventListener('click', applyPresetFlow);
                wrap.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyPresetFlow(); } });

                card.querySelector('.pp_update').onclick = async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Update "${p.name}" with your current profile?`)) return;
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    btn.textContent = '…';
                    await savePreset(p.name, null);
                    btn.disabled = false;
                    btn.textContent = 'Update';
                };

                card.querySelector('.pp_delete').onclick = async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete preset "${p.name}"?`)) return;
                    try {
                        let raw = await callBackend('DeletePreset', p.name, getSteamId());
                        if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                        if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch (_) { }
                        if (raw.success) { showToast('Deleted', 'info'); loadAndRenderPresets(); }
                        else showToast('Delete failed: ' + raw.error, 'error');
                    } catch (e) { showToast('Error: ' + e.message, 'error'); }
                };

                grid.appendChild(card);
            });
        } catch (e) {
            grid.innerHTML = `<div style="color:inherit;padding:20px;font-size:12px">Error: ${escapeHtml(e.message)}</div>`;
        }
    }

    async function runApply(preset, options) {
        const container = document.getElementById('pp_progress_wrap');
        const totalSteps = Object.values(options).filter(Boolean).length;
        let done = 0;

        if (container) {
            container.style.display = 'block';
            container.innerHTML = `
            <div class="pp_progress">
                <div style="font-size:12px;color:inherit">Applying: <strong>${escapeHtml(preset.name)}</strong></div>
                <div class="pp_bar_track"><div class="pp_bar_fill" id="pp_bar" style="width:0"></div></div>
                <div class="pp_bar_msg" id="pp_bar_msg">Starting…</div>
            </div>`;
        }

        const result = await applyPreset(preset, options, (step, msg) => {
            done = step;
            const pct = Math.round((done / Math.max(totalSteps, 1)) * 100);
            const bar = document.getElementById('pp_bar');
            const msgEl = document.getElementById('pp_bar_msg');
            if (bar) bar.style.width = pct + '%';
            if (msgEl) msgEl.textContent = msg;
        });

        setTimeout(() => { if (container) container.style.display = 'none'; }, 3000);

        if (result.success) {
            showToast('Preset applied! Reload the page to see changes.', 'success', 5000);
        } else {
            showToast('Errors:\n' + result.errors.join('\n'), 'error', 7000);
        }
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
        <div class="pp_header">
            <h2>Profile Presets</h2>
            <p>Save your current profile and restore a saved look.</p>
        </div>
        <div class="pp_save">
            <label class="pp_lbl" for="pp_name_input">Save current profile</label>
            <div class="pp_row">
                <input type="text" class="pp_input" id="pp_name_input" placeholder="Preset name" maxlength="64">
                <button class="pp_btn pp_btn_primary" id="pp_save_btn">Save Preset</button>
            </div>
            <div id="pp_save_status" role="status" aria-live="polite"></div>
        </div>
        <div id="pp_progress_wrap" style="display:none"></div>
        <h3 class="pp_gallery_heading">Saved presets</h3>
        <div class="pp_grid" id="pp_grid"><div class="pp_empty"><p>No presets yet.</p></div></div>`;
        return panel;
    }

    let mountedUI = null;

    function closePanel() {
        if (!mountedUI) return;
        mountedUI.panel?.classList.remove('pp_visible');
        mountedUI.navItem.classList.remove('pp_active');
        if (mountedUI.contentArea) mountedUI.contentArea.style.display = mountedUI.display;
    }

    function findContentArea(privacyLink) {
        const candidates = document.querySelectorAll(
            '[class*="profileedit_Content"], .profile_edit_content, ._23XE60ehNyeIhLHf5L7QPl, [class*="profileedit_Page"]'
        );
        let branch = privacyLink.parentNode;
        while (branch && branch.parentNode && branch.parentNode !== document.body) {
            const siblings = Array.from(branch.parentNode.children).filter(element =>
                element !== branch && element.id !== PANEL_ID && element.id !== NAV_ITEM_ID
                && !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName.toUpperCase())
            );
            const forms = siblings.filter(element => element.matches('form')
                || element.querySelector('form, input, textarea, select'));
            if (forms.length === 1) return forms[0];
            if (branch.querySelectorAll('a[href*="/edit"]').length > 1 && siblings.length === 1) return siblings[0];
            branch = branch.parentNode;
        }
        for (const candidate of candidates) {
            if (!candidate.contains(privacyLink) && candidate.id !== PANEL_ID
                && !candidate.closest('#' + PANEL_ID)) return candidate;
        }
        return null;
    }

    function injectUI() {
        const privacyLink = document.querySelector('a[href*="/edit/settings"]');
        if (mountedUI && (!privacyLink || !mountedUI.navItem.isConnected
            || mountedUI.sidebar !== privacyLink.parentNode
            || mountedUI.navItem.parentNode !== privacyLink.parentNode)) {
            closePanel();
            mountedUI.navItem.remove();
            mountedUI.panel?.remove();
            mountedUI = null;
        }
        if (!privacyLink) return false;

        if (!mountedUI) {
            document.getElementById(NAV_ITEM_ID)?.remove();
            document.getElementById(PANEL_ID)?.remove();
            injectStyles();

            const navItem = document.createElement('a');
            navItem.id = NAV_ITEM_ID;
            navItem.href = '#profile-presets';
            navItem.className = privacyLink.className;
            navItem.textContent = 'Profile Presets';
            mountedUI = { navItem, panel: null, contentArea: null, sidebar: privacyLink.parentNode, display: '' };

            navItem.onclick = e => {
                e.preventDefault();
                e.stopPropagation();
                injectUI();
                if (!mountedUI?.panel) {
                    showToast('Profile editor content is still loading. Please try again.', 'error');
                    return;
                }
                if (navItem.classList.contains('pp_active')) return;
                mountedUI.display = mountedUI.contentArea.style.display;
                mountedUI.contentArea.style.display = 'none';
                mountedUI.panel.classList.add('pp_visible');
                navItem.classList.add('pp_active');
                loadAndRenderPresets();
            };
            privacyLink.parentNode.insertBefore(navItem, privacyLink.nextSibling);
        }

        const contentArea = findContentArea(privacyLink);
        if (mountedUI.panel && (mountedUI.contentArea !== contentArea
            || !mountedUI.panel.isConnected || mountedUI.panel.parentNode !== contentArea?.parentNode)) {
            closePanel();
            mountedUI.panel.remove();
            mountedUI.panel = null;
            mountedUI.contentArea = null;
        }
        if (!contentArea) return false;
        if (mountedUI.panel) return true;

        const panel = buildPanel();
        contentArea.parentNode.insertBefore(panel, contentArea.nextSibling);
        Object.assign(mountedUI, { panel, contentArea, display: contentArea.style.display });

        const saveBtn = panel.querySelector('#pp_save_btn');
        const nameInput = panel.querySelector('#pp_name_input');
        const statusEl = panel.querySelector('#pp_save_status');

        saveBtn.onclick = async () => {
            if (saveBtn.disabled || saveInProgress) return;
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); showToast('Enter a preset name', 'error'); return; }
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
            statusEl.textContent = '';
            try {
                if (await savePreset(name, statusEl)) nameInput.value = '';
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Preset';
            }
        };
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });

        return true;
    }

    function init() {
        document.addEventListener('click', e => {
            const link = e.target.closest?.('a');
            if (mountedUI && link && link !== mountedUI.navItem && link.matches('a[href*="/edit"]')) closePanel();
        }, true);
        window.addEventListener('popstate', closePanel);
        const observer = new MutationObserver(injectUI);
        observer.observe(document.body, { childList: true, subtree: true });
        injectUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

}

let PluginEntryPointMain = function () {
    return { default: async function () { } };
};

function ExecutePluginModule() {
    MILLENNIUM_BACKEND_IPC.postMessage(0, {
        pluginName: pluginName,
        methodName: "__builtins__.__millennium_plugin_settings_parser__"
    }).then(async () => {
        let mod = PluginEntryPointMain();
        Object.assign(window.PLUGIN_LIST[pluginName], {
            ...mod,
            __millennium_internal_plugin_name_do_not_use_or_change__: pluginName
        });
        await mod.default();
    });
}
ExecutePluginModule();
