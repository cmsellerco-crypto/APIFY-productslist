import { Actor } from 'apify';
import { PlaywrightCrawler, enqueueLinks } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const startUrls = input.startUrls ?? [];
const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : 200;
const productLinkSelector =
  input.productLinkSelector ?? "a[href*='product'], a[href*='/p/'], a[href*='/dp/']";
const sameDomainOnly = input.sameDomainOnly ?? true;

let saved = 0;

function pickJsonLdProduct(blocks) {
  for (const block of blocks) {
    const dataArr = Array.isArray(block) ? block : [block];

    for (const obj of dataArr) {
      const nodes = obj?.['@graph'] ? obj['@graph'] : [obj];

      for (const n of nodes) {
        const t = n?.['@type'];
        const isProduct =
          t === 'Product' || (Array.isArray(t) && t.includes('Product'));

        if (n && isProduct) return n;
      }
    }
  }
  return null;
}

function normalizeGtin(product) {
  return (
    product?.gtin13 ||
    product?.gtin12 ||
    product?.gtin14 ||
    product?.gtin ||
    null
  );
}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 20000,

  async requestHandler({ request, page, log }) {
    if (saved >= maxItems) return;

    // Tenta extrair JSON-LD (muitas lojas expõem Product aqui)
    const jsonLdRaw = await page.$$eval(
      'script[type="application/ld+json"]',
      (els) => els.map((e) => e.textContent).filter(Boolean)
    );

    const jsonLdBlocks = [];
    for (const txt of jsonLdRaw) {
      try {
        jsonLdBlocks.push(JSON.parse(txt));
      } catch {
        // ignora JSON inválido
      }
    }

    const product = pickJsonLdProduct(jsonLdBlocks);

    if (product) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;

      const out = {
        url: request.loadedUrl || request.url,
        title: product.name ?? null,
        brand: product.brand?.name ?? product.brand ?? null,
        sku: product.sku ?? null,
        gtin: normalizeGtin(product),
        price: offers?.price ?? null,
        currency: offers?.priceCurrency ?? null
      };

      await Actor.pushData(out);
      saved += 1;

      log.info(`✅ Produto salvo (${saved}/${maxItems}): ${out.title ?? out.url}`);
      return;
    }

    // Se não achou JSON-LD de produto, trata como página de lista/busca e segue links.
    await enqueueLinks({
      page,
      selector: productLinkSelector,
      strategy: sameDomainOnly ? 'same-domain' : 'all',
      requestQueue: crawler.requestQueue
    });

    log.info(`📄 Página de lista/busca: links enfileirados. URL: ${request.url}`);
  }
});

// Aceita startUrls no formato do editor do Apify (objetos {url})
const normalizedStartUrls = startUrls.map((u) =>
  typeof u === 'string' ? { url: u } : u
);

await crawler.run(normalizedStartUrls);

await Actor.exit();
