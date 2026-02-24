# Imagem do Apify já preparada para Playwright (inclui browsers e deps)
FROM apify/actor-node-playwright-chrome:20

# Copia o código
COPY . ./

# Instala dependências
RUN npm install --omit=dev

# Comando padrão do actor
CMD npm start
