import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const startUrls = input.startUrls ?? [];
const maxItems = input.maxItems ?? 20;

let saved = 0;

const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxItems * 2,
    maxConcurrency: 2,

    async requestHandler({ request, page, enqueueLinks, log }) {

        if (saved >= maxItems) return;

        const url = request.url;

        // ================================
        // LISTAGEM (brand page)
        // ================================
        if (!url.includes('/ip/')) {

            await page.waitForTimeout(2000);

            for (let i = 0; i < 6; i++) {
                await page.mouse.wheel(0, 3000);
                await page.waitForTimeout(1500);
            }

            const links = await page.$$eval(
                "a[href*='/ip/']",
                els => els.map(e => e.href)
            );

            const uniqueLinks = [...new Set(links)];

            log.info(`🔎 ${uniqueLinks.length} links encontrados.`);

            await enqueueLinks({
                urls: uniqueLinks.slice(0, maxItems)
            });

            return;
        }

        // ================================
        // PRODUTO
        // ================================
        await page.waitForTimeout(2500);

        // Intercepta dados do script JSON embutido
        const productJson = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll("script"));
            for (const s of scripts) {
                if (s.textContent && s.textContent.includes('"__WML_REDUX_INITIAL_STATE__"')) {
                    const match = s.textContent.match(/window\.__WML_REDUX_INITIAL_STATE__\s*=\s*({.*});/);
                    if (match && match[1]) {
                        try {
                            return JSON.parse(match[1]);
                        } catch {
                            return null;
                        }
                    }
                }
            }
            return null;
        });

        if (!productJson?.product?.products) {
            log.warning("⚠️ Produto JSON não encontrado.");
            return;
        }

        try {
            const products = productJson.product.products;
            const key = Object.keys(products)[0];
            const product = products[key];

            const output = {
                Retailer: "walmart",
                Brand: product.brand ?? null,
                ProductId: product.usItemId ?? null,
                ProductTitle: product.productName ?? null,
                ProductUrl: url,
                ImageUrl: product.imageInfo?.thumbnailUrl ?? null,
                VariantId: product.usItemId ?? null,
                SKU: product.model ? String(product.model) : null,
                UPC: product.upc ? String(product.upc) : null,
                Color: null,
                Size: null,
                Price: product.priceInfo?.currentPrice?.price ?? null,
                ListPrice: product.priceInfo?.wasPrice?.price ?? null,
                Availability: product.availabilityStatus ?? null,
                Currency: "USD"
            };

            await Actor.pushData(output);
            saved++;

            log.info(`✅ Produto salvo (${saved}/${maxItems})`);

        } catch (err) {
            log.warning("❌ Erro ao processar produto.");
        }
    }
});

await crawler.run(startUrls);
await Actor.exit();
