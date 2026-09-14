import { NextResponse } from "next/server";
import { VENDEDORES, PIPELINE_VENDAS_ID } from "../../../lib/pipedrive-config";

const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BASE = "https://api.pipedrive.com/v1";

let cache = null;
const CACHE_MS = 15 * 60 * 1000;

async function fetchAllPaginated(url) {
  const items = [];
  let start = 0;
  const limit = 500;
  while (true) {
    const sep = url.includes("?") ? "&" : "?";
    const pageUrl = `${url}${sep}start=${start}&limit=${limit}&api_token=${TOKEN}`;
    const resp = await fetch(pageUrl);
    if (!resp.ok) {
      throw new Error(`Pipedrive respondeu ${resp.status} em ${url}`);
    }
    const json = await resp.json();
    if (!json.success) throw new Error(json.error || "Falha na Pipedrive");
    const data = json.data || [];
    items.push(...data);
    const more = json.additional_data?.pagination?.more_items_in_collection;
    if (!more || data.length === 0) break;
    start += limit;
  }
  return items;
}

function limitesMesAtual() {
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0);
  const fim = new Date(agora.getFullYear(), agora.getMonth() + 1, 1, 0, 0, 0);
  return { inicio, fim };
}

function nomeMesAtual() {
  const meses = [
    "janeiro","fevereiro","março","abril","maio","junho",
    "julho","agosto","setembro","outubro","novembro","dezembro",
  ];
  const agora = new Date();
  return `${meses[agora.getMonth()]} de ${agora.getFullYear()}`;
}

async function calcular() {
  if (!TOKEN) {
    return { erro: "Token do Pipedrive não configurado no servidor." };
  }

  const { inicio, fim } = limitesMesAtual();

  const orgsPromises = VENDEDORES.map((v) =>
    fetchAllPaginated(`${BASE}/organizations?user_id=${v.owner_id}`).then(
      (orgs) => ({ vendedor: v, orgs })
    )
  );

  // Todos os deals do funil de Vendas (sem filtro de data — precisamos
  // deles para saber a qual org/dono uma atividade pertence, mesmo que
  // o deal tenha sido criado em outro mês).
  const dealsPromise = fetchAllPaginated(
    `${BASE}/deals?pipeline_id=${PIPELINE_VENDAS_ID}&status=all_not_deleted`
  );

  // Atividades concluídas. Filtramos por data como otimização (due_date),
  // mas o corte real é feito depois usando marked_as_done_time.
  const dataIni = inicio.toISOString().split("T")[0];
  const dataFim = fim.toISOString().split("T")[0];
  const activitiesPromise = fetchAllPaginated(
    `${BASE}/activities?done=1&start_date=${dataIni}&end_date=${dataFim}`
  );

  const [dealsResult, activitiesResult, ...orgsResults] = await Promise.all([
    dealsPromise,
    activitiesPromise,
    ...orgsPromises,
  ]);

  const dealsPorId = new Map(dealsResult.map((d) => [d.id, d]));

  const orgsPorVendedor = new Map();
  for (const { vendedor, orgs } of orgsResults) {
    orgsPorVendedor.set(vendedor.owner_id, {
      vendedor,
      orgs: new Map(orgs.map((o) => [o.id, o])),
    });
  }

  // Quais organizações tiveram ao menos 1 atividade realizada neste mês,
  // em um deal do funil de Vendas, agrupado por dono do deal.
  const orgsTrabalhadasPorOwner = new Map();
  for (const a of activitiesResult) {
    if (!a.done || !a.deal_id || !a.marked_as_done_time) continue;

    const quando = new Date(a.marked_as_done_time);
    if (quando < inicio || quando >= fim) continue;

    const deal = dealsPorId.get(a.deal_id);
    if (!deal || !deal.org_id?.value) continue;

    const owner = deal.user_id?.value ?? deal.owner_id?.id;
    if (!owner) continue;

    if (!orgsTrabalhadasPorOwner.has(owner)) {
      orgsTrabalhadasPorOwner.set(owner, new Set());
    }
    orgsTrabalhadasPorOwner.get(owner).add(deal.org_id.value);
  }

  const porVendedor = VENDEDORES.map((v) => {
    const entrada = orgsPorVendedor.get(v.owner_id);
    const carteira = entrada.orgs;
    const trabalhadasGlobal =
      orgsTrabalhadasPorOwner.get(v.owner_id) ?? new Set();
    const trabalhadasDaCarteira = [...trabalhadasGlobal].filter((oid) =>
      carteira.has(oid)
    );
    const nao_abordadas = [...carteira.values()]
      .filter((o) => !trabalhadasGlobal.has(o.id))
      .map((o) => ({ id: o.id, name: o.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    const total = carteira.size;
    const abordados = trabalhadasDaCarteira.length;
    const pct = total > 0 ? Math.round((abordados / total) * 100) : 0;

    return {
      vendedor: v.nome,
      total_carteira: total,
      abordados,
      nao_abordados_qtd: nao_abordadas.length,
      pct_cobertura: pct,
      nao_abordados: nao_abordadas,
    };
  });

  const total = porVendedor.reduce((s, v) => s + v.total_carteira, 0);
  const abordados = porVendedor.reduce((s, v) => s + v.abordados, 0);
  const pct_geral = total > 0 ? Math.round((abordados / total) * 100) : 0;

  return {
    mes: nomeMesAtual(),
    gerado_em: new Date().toISOString(),
    total_carteira: total,
    total_abordados: abordados,
    pct_cobertura_geral: pct_geral,
    por_vendedor: porVendedor,
  };
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.has("refresh");

    if (!forceRefresh && cache && Date.now() - cache.at < CACHE_MS) {
      return NextResponse.json({ ...cache.data, _cached: true });
    }
    const data = await calcular();
    if (data.erro) return NextResponse.json({ erro: data.erro }, { status: 500 });
    cache = { at: Date.now(), data };
    return NextResponse.json({ ...data, _cached: false });
  } catch (err) {
    return NextResponse.json(
      { erro: "Falha ao calcular cobertura.", detalhe: String(err) },
      { status: 502 }
    );
  }
}
