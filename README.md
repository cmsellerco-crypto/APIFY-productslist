# Products Scraper (Apify Actor)

Actor genérico para coletar dados de produtos em sites de varejo.
- Se a página tiver JSON-LD Product, extrai: title, brand, sku, gtin/upc, price, currency.
- Se for página de listagem/busca, enfileira links de produtos usando um CSS selector.

## Input
- startUrls (obrigatório)
- maxItems (default 200)
- productLinkSelector (default: a[href*='product'], a[href*='/p/'], a[href*='/dp/'])
- sameDomainOnly (default true)

## Output (Dataset)
Campos: url, title, brand, sku, gtin, price, currency
