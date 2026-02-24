import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const startUrls = input.startUrls ?? [];
const maxItems = input.maxItems ?? 30;

let saved = 0;

function getProductIdFromUrl(url) {
    const match = url.match(/\/ip\/(\d+)/);
    return match ? match[1] : null;
}

const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxItems * 5,
    maxConcurrency: 2,

    async requestHandler({ request, page, enqueueLinks, log }) {

        if (saved >= maxItems) return;

        const url = request.url;

        // 🔹 1) Se for página de produto Walmart
        if (url.includes('/ip/')) {

            await page.waitForTimeout(2000);

            const productData = await page.evaluate(() => {
                return window.__WML_REDUX_INITIAL_STATE__;
            }).catch(() => null);

            if (!productData) {
                log.warning('Redux state não encontrado.');
                return;
            }

            try {
                const products = productData?.product?.products;
                const productKey = Object.keys(products)[0];
                const product = products[productKey];

                const out = {
                    Retailer: "walmart",
                    Brand: product.brand || null,
                    ProductId: product.usItemId || null,
                    ProductTitle: product.productName || null,
                    ProductUrl: window.location.href,
                    ImageUrl: product.imageInfo?.thumbnailUrl || null,
                    VariantId: product.usItemId || null,
                    SKU: product.model || null,
                    UPC: product.upc || null,
                    Color: null,
                    Size: null,
                    Price: product.priceInfo?.currentPrice?.price || null,
                    ListPrice: product.priceInfo?.wasPrice?.price || null,
                    Availability: product.availabilityStatus || null,
                    Currency: "USD"
                };

                await Actor.pushData(out);
                saved++;

                log.info(`✅ Produto salvo (${saved}/${maxItems})`);
            } catch (err) {
                log.warning("Erro ao extrair produto.");
            }

            return;
        }

        // 🔹 2) Se for listagem (brand page)
        await page.waitForTimeout(2000);

        for (let i = 0; i < 6; i++) {
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(1500);
        }

        const links = await page.$$eval("a[href*='/ip/']", els =>
            els.map(e => e.href)
        );

        const uniqueLinks = [...new Set(links)];

        log.info(`🔎 ${uniqueLinks.length} links encontrados na listagem.`);

        await enqueueLinks({
            urls: uniqueLinks.slice(0, maxItems),
        });
    }
});

await crawler.run(startUrls);
await Actor.exit();
