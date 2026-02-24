import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const startUrls = input.startUrls ?? [];
const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : 200;

// Para Walmart, recomendo: "a[href*='/ip/'], a[href*='/sp/']"
const productLinkSelector =
  input.productLinkSelector ??
  "a[href*='product'], a[href*='/p/'], a[href*='/dp/'], a[href*='/ip/'], a[href*='/sp/']";

const sameDomainOnly = input.sameDomainOnly ?? true;

// Quantidade de scrolls para páginas de listagem (Walmart geralmente precisa)
const scrollRounds = Number.isFinite(input.scrollRounds) ? input.scrollRounds : 8;
const scrollPixels = Number.isFinite(input.scrollPixels) ? input.scrollPixels : 2200;
const scrollWaitMs = Number.isFinite(input.scrollWaitMs) ? input.scrollWaitMs : 1400;

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

async function extractJsonLdProduct(page) {
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
  return pickJsonLdProduct(jsonLdBlocks);
}

async function doListingScroll(page) {
  // Pequena espera para a página renderizar componentes JS
  await page.waitForTimeout(2000);

  for (let i = 0; i < scrollRounds; i++) {
    await page.mouse.wheel(0, scrollPixels);
    await page.waitForTimeout(scrollWaitMs);
  }
}

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 20000,

  async requestHandler(context) {
    const { request, page, log, enqueueLinks } = context;

    if (saved >= maxItems) {
      log.info(`✅ Atingiu maxItems (${maxItems}). Parando de salvar itens.`);
      return;
    }

    // 1) Primeiro tenta extrair produto via JSON-LD (se for página de produto)
    const product = await extractJsonLdProduct(page);

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

    // 2) Se não é produto, trata como listagem/busca (ex.: Walmart brand page)
    await doListingScroll(page);

    // Log de diagnóstico: quantos links existem no DOM agora?
    const linkCount = await page.$$eval(productLinkSelector, (els) => els.length).catch(() => 0);
    log.info(`📄 Listagem detectada. Links de produto encontrados no DOM: ${linkCount}`);

    // Enfileira links de produto
    await enqueueLinks({
      selector: productLinkSelector,
      strategy: sameDomainOnly ? 'same-domain' : 'all'
    });

    log.info(`📥 Links enfileirados a partir de: ${request.url}`);
  }
});

// Aceita startUrls no formato do editor do Apify (objetos {url})
const normalizedStartUrls = startUrls.map((u) =>
  typeof u === 'string' ? { url: u } : u
);

await crawler.run(normalizedStartUrls);

await Actor.exit();
