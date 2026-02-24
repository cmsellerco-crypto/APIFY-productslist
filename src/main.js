// src/main.js
import { Actor } from 'apify';
import {
    PlaywrightCrawler,
    log,
    RequestQueue,
    sleep,
} from 'crawlee';

function normalizeUrl(url, baseUrl) {
    try {
        return new URL(url, baseUrl).toString();
    } catch {
        return null;
    }
}

function uniq(arr) {
    return [...new Set(arr.filter(Boolean))];
}

async function autoScroll(page, steps = 8, stepDelayMs = 800) {
    for (let i = 0; i < steps; i++) {
        await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
        await page.waitForTimeout(stepDelayMs);
    }
    // volta um pouquinho (às vezes ajuda a renderizar cards)
    await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.2)));
    await page.waitForTimeout(400);
}

function extractFromJsonLd(jsonLd) {
    // aceita objeto ou array
    const nodes = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
    const products = [];

    for (const node of nodes) {
        if (!node) continue;

        // graph
        if (node['@graph'] && Array.isArray(node['@graph'])) {
            for (const g of node['@graph']) products.push(...extractFromJsonLd(g));
            continue;
        }

        const type = node['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
            products.push(node);
        }
    }

    return products;
}

function pickOffer(offers) {
    if (!offers) return null;
    if (Array.isArray(offers)) return offers[0] || null;
    return offers;
}

function safeNumber(x) {
    if (x === null || x === undefined) return null;
    const n = Number(String(x).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * Walmart: tenta extrair links/ids da listagem via __NEXT_DATA__
 */
function walmartLinksFromNextData(nextData, baseUrl) {
    const links = [];

    try {
        // Estrutura pode variar bastante.
        // Vamos percorrer recursivamente e procurar strings que parecem URLs de /ip/
        const seen = new Set();

        const walk = (obj) => {
            if (!obj || typeof obj !== 'object') return;

            if (typeof obj === 'string') {
                if (obj.includes('/ip/')) {
                    const url = normalizeUrl(obj.startsWith('http') ? obj : obj, baseUrl);
                    if (url && !seen.has(url)) {
                        seen.add(url);
                        links.push(url);
                    }
                }
                return;
            }

            if (Array.isArray(obj)) {
                for (const it of obj) walk(it);
                return;
            }

            for (const v of Object.values(obj)) {
                if (typeof v === 'string') {
                    if (v.includes('/ip/')) {
                        const url = normalizeUrl(v.startsWith('http') ? v : v, baseUrl);
                        if (url && !seen.has(url)) {
                            seen.add(url);
                            links.push(url);
                        }
                    }
                } else {
                    walk(v);
                }
            }
        };

        walk(nextData);
    } catch {
        // ignore
    }

    return links;
}

async function extractListingLinks(page, { productLinkSelector }) {
    const baseUrl = page.url();

    // 1) Tenta __NEXT_DATA__ (Walmart frequentemente usa isso em search/cp/brand)
    let nextLinks = [];
    try {
        const nextDataJson = await page.locator('script#__NEXT_DATA__').first().textContent({ timeout: 2000 });
        if (nextDataJson) {
            const nextData = JSON.parse(nextDataJson);
            nextLinks = walmartLinksFromNextData(nextData, baseUrl);
            if (nextLinks.length) {
                log.info(`🧠 __NEXT_DATA__ detectado. Links encontrados: ${nextLinks.length}`);
            }
        }
    } catch {
        // sem NEXT_DATA ou parse falhou — segue
    }

    // 2) Scroll + DOM fallback
    // (muita página só injeta os cards no DOM depois)
    await autoScroll(page, 10, 800);

    const domLinks = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter(Boolean));
    const filtered = domLinks
        .map((href) => {
            // aceita o selector custom e também /ip/ que é bem padrão do Walmart
            const ok =
                (productLinkSelector && href && href.includes(productLinkSelector.replace(/[\[\]]/g, ''))) ||
                href.includes('/ip/');
            if (!ok) return null;
            return href;
        })
        .filter(Boolean);

    const normalizedDom = uniq(filtered.map((u) => {
        // Walmart tem links relativos
        if (u.startsWith('//')) return `https:${u}`;
        return normalizeUrl(u, baseUrl);
    }));

    // Junta tudo
    const links = uniq([...nextLinks, ...normalizedDom]);

    return links;
}

async function extractProductData(page) {
    const url = page.url();

    // 1) JSON-LD Product
    let jsonLdProducts = [];
    try {
        const jsonLdTexts = await page.$$eval('script[type="application/ld+json"]', (els) =>
            els.map((e) => e.textContent).filter(Boolean)
        );

        for (const t of jsonLdTexts) {
            try {
                const parsed = JSON.parse(t);
                jsonLdProducts.push(...extractFromJsonLd(parsed));
            } catch {
                // alguns scripts têm JSON inválido — ignora
            }
        }
    } catch {
        // ignore
    }

    if (jsonLdProducts.length) {
        const p = jsonLdProducts[0];
        const offer = pickOffer(p.offers);

        const title = p.name ?? null;
        const brand =
            (typeof p.brand === 'string' ? p.brand : (p.brand?.name ?? null)) ?? null;

        const sku = p.sku ?? p.mpn ?? null;
        const gtin =
            p.gtin13 ?? p.gtin12 ?? p.gtin14 ?? p.gtin8 ?? p.gtin ?? null;

        const price = offer?.price ?? offer?.lowPrice ?? null;
        const currency = offer?.priceCurrency ?? null;

        return {
            url,
            title,
            brand,
            sku,
            gtin,
            price: price !== null ? safeNumber(price) : null,
            currency,
            source: 'json-ld',
        };
    }

    // 2) Fallback simples (título do HTML)
    const title = await page.title().catch(() => null);

    return {
        url,
        title,
        brand: null,
        sku: null,
        gtin: null,
        price: null,
        currency: null,
        source: 'fallback',
    };
}

await Actor.init();

const input = await Actor.getInput() ?? {};
const startUrls = (input.startUrls ?? []).map((u) => (typeof u === 'string' ? u : u?.url)).filter(Boolean);
const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : 200;
const sameDomainOnly = input.sameDomainOnly !== false;
const productLinkSelector =
    input.productLinkSelector ||
    'a[href*="/ip/"], a[href*="/dp/"], a[href*="/p/"], a[href*="product"]';

if (!startUrls.length) {
    throw new Error('startUrls é obrigatório (adicione pelo menos 1 URL).');
}

log.info(`✅ Iniciando com ${startUrls.length} startUrls | maxItems=${maxItems} | sameDomainOnly=${sameDomainOnly}`);

const requestQueue = await Actor.openRequestQueue();

// Enfileira as startUrls
await requestQueue.addRequests(
    startUrls.map((url) => ({ url, userData: { label: 'START' } }))
);

let savedCount = 0;

const crawler = new PlaywrightCrawler({
    requestQueue,

    // Concurrency baixa ajuda MUITO no Apify pra não estourar memória
    maxConcurrency: 1,

    // timeouts mais generosos (Walmart é pesado)
    requestHandlerTimeoutSecs: 180,

    // reduzir retries para evitar loop em páginas bloqueadas
    maxRequestRetries: 2,

    // configurações do Playwright
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },

    // bloqueia recursos pesados (memória!)
    preNavigationHooks: [
        async ({ page }) => {
            await page.route('**/*', async (route) => {
                const req = route.request();
                const type = req.resourceType();
                const url = req.url();

                // bloqueia imagens, fontes, mídia e trackers comuns
                if (['image', 'media', 'font'].includes(type)) return route.abort();

                // alguns scripts de tracking pesam muito
                if (
                    url.includes('googletagmanager') ||
                    url.includes('google-analytics') ||
                    url.includes('doubleclick') ||
                    url.includes('adsystem') ||
                    url.includes('adservice')
                ) return route.abort();

                return route.continue();
            });

            // dá um tempinho pra estabilizar
            page.setDefaultTimeout(45000);
        },
    ],

    requestHandler: async ({ request, page }) => {
        const url = request.url;

        // respeita maxItems
        if (savedCount >= maxItems) {
            log.info(`🛑 maxItems atingido (${savedCount}). Parando de salvar/enfileirar.`);
            return;
        }

        // Heurística: página de produto vs listagem
        const isLikelyProduct =
            url.includes('/ip/') ||
            url.includes('/dp/') ||
            url.includes('/p/') ||
            request.userData?.label === 'DETAIL';

        if (isLikelyProduct) {
            const data = await extractProductData(page);

            // salva no dataset
            if (savedCount < maxItems) {
                await Actor.pushData(data);
                savedCount++;
                log.info(`✅ Produto salvo (${savedCount}/${maxItems}): ${data.title ?? '(sem título)'}`);
            }
            return;
        }

        // LISTAGEM / START
        log.info(`📄 Listagem detectada. Extraindo links... (${url})`);

        const links = await extractListingLinks(page, { productLinkSelector });

        log.info(`🔗 Links candidatos encontrados: ${links.length}`);

        // filtra por domínio (opcional)
        let finalLinks = links;
        if (sameDomainOnly) {
            const base = new URL(url);
            finalLinks = links.filter((u) => {
                try {
                    return new URL(u).hostname === base.hostname;
                } catch {
                    return false;
                }
            });
        }

        // limita quantidade para não enfileirar “o universo”
        const remaining = Math.max(0, maxItems - savedCount);
        const toEnqueue = finalLinks.slice(0, Math.max(remaining * 3, 50)); // enfileira mais do que remaining para compensar páginas sem JSON-LD

        log.info(`📥 Enfileirando ${toEnqueue.length} links de produto...`);

        await requestQueue.addRequests(
            toEnqueue.map((u) => ({ url: u, userData: { label: 'DETAIL' } }))
        );

        // evita bater muito rápido
        await sleep(500);
    },
});

await crawler.run();

log.info(`🏁 Finalizado. Itens salvos no Dataset: ${savedCount}. Exporte como CSV no Apify.`);

await Actor.exit();
