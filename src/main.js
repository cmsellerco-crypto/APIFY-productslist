import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const startUrls = input.startUrls ?? [];
const maxItems = input.maxItems ?? 20;

let saved = 0;

// Extrai ID do produto da URL (/ip/123456789)
function extractProductId(url) {
    const match = url.match(/\/ip\/(\d+)/);
    return match ? match[1] : null;
}

const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxItems * 3,
    maxConcurrency: 2,

    async requestHandler({ request, page, enqueueLinks, log }) {

        if (saved >= maxItems) return;

        const url = request.url;

        // ================================
        // 1️⃣ PÁGINA DE PRODUTO WALMART
        // ================================
        if (url.includes('/ip/')) {

            await page.waitForTimeout(2500);

            const reduxState = await page.evaluate(() => {
                return window.__WML_REDUX_INITIAL_STATE__;
            }).catch(() => null);

            if (!reduxState?.product?.products) {
                log.warning("⚠️ Redux state não encontrado.");
                return;
            }

            try {
                const products = reduxState.product.products;
                const productKey = Object.keys(products)[0];
                const product = products[productKey];

                const priceInfo = product.priceInfo || {};
                const currentPrice = priceInfo.currentPrice?.price ?? null;
                const listPrice = priceInfo.wasPrice?.price ?? null;

                const output = {
                    Retailer: "walmart",
                    Brand: product.brand ?? null,
                    ProductId: product.usItemId ?? extractProductId(url),
                    ProductTitle: product.productName ?? null,
                    ProductUrl: url,
                    ImageUrl: product.imageInfo?.thumbnailUrl ?? null,
                    VariantId: product.usItemId ?? extractProductId(url),
                    SKU: product.model ? String(product.model) : null,
                    UPC: product.upc ? String(product.upc) : null,
                    Color: null,
                    Size: null,
                    Price: currentPrice,
                    ListPrice: listPrice,
                    Availability: product.availabilityStatus ?? null,
                    Currency: "USD"
                };

                await Actor.pushData(output);
                saved++;

                log.info(`✅ Produto salvo (${saved}/${maxItems})`);
            } catch (err) {
                log.warning("❌ Erro ao extrair produto.");
            }

            return;
        }

        // ================================
        // 2️⃣ PÁGINA DE LISTAGEM (Brand)
        // ================================
        await page.waitForTimeout(2000);

        // Scroll para carregar lazy load
        for (let i = 0; i < 6; i++) {
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(1500);
        }

        const links = await page.$$eval(
            "a[href*='/ip/']",
            elements => elements.map(el => el.href)
        );

        const uniqueLinks = [...new Set(links)];

        log.info(`🔎 ${uniqueLinks.length} links encontrados na listagem.`);

        await enqueueLinks({
            urls: uniqueLinks.slice(0, maxItems)
        });
    }
});

await crawler.run(startUrls);
await Actor.exit();
