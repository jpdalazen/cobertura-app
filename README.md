# Painel de Cobertura de Carteira

Painel simples que mostra, para cada vendedor (Augusto, Tiago, Welynton),
qual % da carteira dele já teve pelo menos 1 negócio criado no mês atual —
no funil de Vendas.

## O que já vem pronto

- % de cobertura geral do time no topo
- 1 card por vendedor com: % do mês, nº de abordados, nº de não abordados
- Lista clicável de "quem ainda não foi trabalhado" dentro de cada card
- Cache de 15 minutos (para não consumir muita cota da API do Pipedrive)
- Botão de "Atualizar agora" que ignora o cache quando você precisa
- Dados vêm direto do Pipedrive, ao vivo

## Como funciona por trás

A cada requisição:
1. Busca a carteira de cada vendedor (organizações onde o vendedor é o dono)
2. Busca todos os negócios do funil de Vendas
3. Filtra apenas os negócios criados desde o dia 1º do mês corrente
4. Cruza: para cada vendedor, quantas organizações da carteira aparecem
   como "org_id" de pelo menos 1 desses negócios novos

Não considera o "Funil de Leads" (pipeline 2) — só o funil de Vendas,
que é o que reflete atividade comercial real.

## Passo a passo para subir na Vercel

1. Crie conta em vercel.com (pode entrar com GitHub).
2. Suba essa pasta para um repositório do GitHub:
   ```
   git init
   git add .
   git commit -m "primeira versão"
   git branch -M main
   git remote add origin <URL_DO_SEU_REPOSITORIO>
   git push -u origin main
   ```
3. Na Vercel: "Add New Project" → importe o repositório → em
   "Environment Variables" adicione:
   - Nome: `PIPEDRIVE_API_TOKEN`
   - Valor: seu token do Pipedrive
4. Clique em Deploy. Em ~1 min a Vercel te dá o link.

## Testando localmente

```
npm install
cp .env.local.example .env.local
# edite .env.local e cole o token
npm run dev
```

Abre em `http://localhost:3000`.

## Ajustes futuros possíveis

- Adicionar gráfico de tendência dos últimos meses (guardar histórico
  em algum banco simples, tipo Vercel KV)
- Comparação com mês anterior lado a lado
- Ranking com destaque para quem está pior/melhor
- Exportar a lista de não abordados como .csv

É só me avisar quando quiser.
