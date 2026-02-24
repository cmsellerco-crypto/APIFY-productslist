// src/main.js
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function absolutizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// Tenta achar URLs de produto dentro do __NEXT_DATA__ (Next.js)
function extractProductUrlsFromNextData(nextData, baseUrl) {
  const out = [];

  const pushIfUrl = (u) => {
    if (!u) return;
    // alguns campos podem ser path "/ip/...."
    const abs = absolutizeUrl(u, baseUrl);
    if (abs) out.push(abs);
  };

  // Busca profunda por qualquer campo que pareça URL de produto
  const visit = (node) => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }

    if (typeof node === 'object') {
      // Campos comuns vistos em páginas de busca/listagem
      const candidates = [
        node.canonicalUrl,
        node.canonicalUrlPath,
        node.productPageUrl,
        node.productPageUrlPath,
        node.url,
        node.link,
        node.seoUrl,
      ];
      for (const c of candidates) pushIfUrl(c);

      for (const k of Object.keys(node)) visit(node[k]);
    }
  };

  // Caminhos frequentes do Walmart (podem mudar)
  // props.pageProps.initialData.searchResult.itemStacks[0].items
  const items =
    nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks?.flatMap((s) => s?.items || []) ||
    nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks?.[0]?.items ||
    nextData?.props?.pageProps?.initialData?.searchResult?.searchResult?.itemStacks?.[0]?.items ||
    null;

  if (items) visit(items);
  // fallback: varre o JSON inteiro
  else visit(nextData);

  // Filtra só URLs que parecem produto no Walmart (ip/)
  const filtered = uniq(out).filter((u) => {
    try {
      const p = new URL(u).pathname;
      return p.includes('/ip/') || p.startsWith('/ip/');
    } catch {
      return false;
    }
  });

  return filtered;
}

// Extrai JSON-LD do tipo Product
function extractJsonLdProductsFromHtml(html) {
  const products = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const json = safeJsonParse(m[1].trim());
    if (!json) continue;

    const candidates = Array.isArray(json) ? json : [json];
    for (const c of candidates) {
      // pode vir como { "@graph": [...] }
      const graph = c?.['@graph'];
      if (Array.isArray(graph)) {
        for (const g of graph) products.push(g);
      } else {
        products.push(c);
      }
    }
  }

  // filtra Product
  return products.filter((p) => {
    const t = p?.['@type'];
    if (Array.isArray(t)) return t.includes('Product');
    return t === 'Product';
  });
}

// Monta um registro padronizado para o Dataset (para CSV depois)
function mapToRecord({ url, title, brand, sku, gtin, upc, price, currency, variantOf, itemId }) {
  return {
    url: url || null,
    title: title || null,
    brand: brand || null,
    sku: sku || null,
    gtin: gtin || null,
    upc: upc || null,
    price: price ?? null,
    currency: currency || null,
    variant_of: variantOf || null,
    item_id: itemId || null,
    scraped_at: new Date().toISOString(),
  };
}

await Actor.init();

const input = await Actor.getInput() || {};

const startUrls = Array.isArray(input.startUrls) ? input.startUrls : [];
const maxItems = Number.isFinite(input.maxItems) ? input.maxItems : 200;
const productLinkSelector =
  input.productLinkSelector ||
  'a[href*="/ip/"], a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"]';
const sameDomainOnly = input.sameDomainOnly !== false; // default true

if (!startUrls.length) {
  throw new Error('Input "startUrls" é obrigatório e deve ser um array.');
}

log.info(`✅ Iniciando com ${startUrls.length} startUrls | maxItems=${maxItems} | sameDomainOnly=${sameDomainOnly}`);

const dataset = await Dataset.open();

let pushedCount = 0;

const crawler = new PlaywrightCrawler({
  maxConcurrency: 1, // mais seguro p/ evitar bloqueio e explosão de memória
  // Você pode aumentar depois.
  requestHandlerTimeoutSecs: 120,

  preNavigationHooks: [
    async ({ page }) => {
      // deixa mais “humano” e reduz detecção boba
      await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
      });
    },
  ],

  async requestHandler({ request, page, enqueueLinks }) {
    const { url } = request;
    const domain = getDomain(url);

    // Pega HTML uma vez
    const html = await page.content();

    // 1) tenta detectar __NEXT_DATA__
    const nextDataText = await page
      .$eval('script#__NEXT_DATA__', (el) => el.textContent)
      .catch(() => null);

    const nextData = nextDataText ? safeJsonParse(nextDataText) : null;

    // Heurística: se não parece página de produto, trate como listagem/busca
    const path = (() => {
      try { return new URL(url).pathname; } catch { return ''; }
    })();

    const looksLikeProduct = path.includes('/ip/');
    const looksLikeListing = !looksLikeProduct;

    if (looksLikeListing) {
      // A) Primeiro tenta puxar URLs de produto do __NEXT_DATA__ (Walmart/Next.js)
      let productUrls = [];
      if (nextData) {
        productUrls = extractProductUrlsFromNextData(nextData, url);
      }

      // B) fallback: DOM selector
      if (!productUrls.length) {
        log.info(`📄 Listagem detectada. Tentando fallback por DOM selector...`);
        await enqueueLinks({
          selector: productLinkSelector,
          limit: Math.max(0, maxItems - pushedCount),
          transformRequestFunction: (req) => {
            if (!req?.url) return null;
            if (sameDomainOnly && getDomain(req.url) !== domain) return null;
            return req;
          },
        });
        log.info(`📥 Links enfileirados a partir de DOM em: ${url}`);
        return;
      }

      // Enfileira as URLs do __NEXT_DATA__
      productUrls = productUrls.slice(0, Math.max(0, maxItems - pushedCount));

      for (const pUrl of productUrls) {
        if (sameDomainOnly && getDomain(pUrl) !== domain) continue;
        await request.queue.addRequest({ url: pUrl, userData: { label: 'PRODUCT' } });
        pushedCount++;
        if (pushedCount >= maxItems) break;
      }

      log.info(`📄 Listagem detectada. Produtos via __NEXT_DATA__: ${productUrls.length} | total enfileirado=${pushedCount}`);
      return;
    }

    // Produto
    // 2) Extrai do JSON-LD
    const jsonLdProducts = extractJsonLdProductsFromHtml(html);

    // Walmart às vezes tem múltiplos blocos; pega o “melhor”
    const bestJsonLd = jsonLdProducts[0] || null;

    // 3) tenta extrair campos também do __NEXT_DATA__ (quando JSON-LD não traz UPC/SKU etc)
    let title = bestJsonLd?.name;
    let brand = bestJsonLd?.brand?.name || bestJsonLd?.brand;
    let sku = bestJsonLd?.sku;
    let gtin = bestJsonLd?.gtin || bestJsonLd?.gtin13 || bestJsonLd?.gtin12;
    let upc = bestJsonLd?.gtin12 || null;

    let price = null;
    let currency = null;

    const offer = Array.isArray(bestJsonLd?.offers) ? bestJsonLd?.offers?.[0] : bestJsonLd?.offers;
    if (offer) {
      price = offer.price ?? null;
      currency = offer.priceCurrency ?? null;
    }

    // Puxa mais dados do nextData (tolerante)
    let itemId = null;
    let variantOf = null;

    if (nextData) {
      // alguns caminhos frequentes do Walmart
      const raw =
        nextData?.props?.pageProps?.initialData?.data ||
        nextData?.props?.pageProps?.initialData ||
        nextData?.props?.pageProps ||
        null;

      const tryVisit = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(tryVisit);
        if (typeof node !== 'object') return;

        // heurísticas para capturar campos comuns
        if (!title && typeof node.name === 'string') title = node.name;
        if (!brand && (typeof node.brand === 'string' || typeof node.brand?.name === 'string')) {
          brand = node.brand?.name || node.brand;
        }
        if (!sku && typeof node.sku === 'string') sku = node.sku;
        if (!gtin && typeof node.gtin === 'string') gtin = node.gtin;
        if (!upc && typeof node.upc === 'string') upc = node.upc;

        if (!itemId && (typeof node.itemId === 'string' || typeof node.itemId === 'number')) {
          itemId = String(node.itemId);
        }

        // preço pode vir como { price: { price: 12.34, currencyUnit: "USD" } } etc
        if (price == null && typeof node.price === 'number') price = node.price;
        if (!currency && typeof node.currency === 'string') currency = node.currency;
        if (!currency && typeof node.currencyUnit === 'string') currency = node.currencyUnit;

        // “variantOf” pode aparecer de várias formas
        if (!variantOf && typeof node.variantOf === 'string') variantOf = node.variantOf;

        for (const k of Object.keys(node)) tryVisit(node[k]);
      };

      tryVisit(raw);
    }

    const record = mapToRecord({
      url,
      title,
      brand,
      sku,
      gtin,
      upc,
      price,
      currency,
      variantOf,
      itemId,
    });

    await dataset.pushData(record);

    log.info(`✅ Produto salvo: ${record.title || '(sem título)'} | sku=${record.sku || '-'} | gtin/upc=${record.gtin || record.upc || '-'}`);
  },
});

await crawler.run(startUrls.map((u) => ({ url: u.url || u, userData: { label: 'START' } })));

log.info(`✅ Finalizado. Itens salvos no Dataset (exporte como CSV no Apify).`);
await Actor.exit();
