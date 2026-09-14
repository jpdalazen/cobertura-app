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

async function calcular({ debug = false } = {}) {
  if (!TOKEN) {
    return { erro: "Token do Pipedrive não configurado no servidor." };
  }

  const { inicio, fim } = limitesMesAtual();

  const orgsPromises = VENDEDORES.map((v) =>
    fetchAllPaginated(`${BASE}/organizations?user_id=${v.owner_id}`).then(
      (orgs) => ({ vendedor: v, orgs })
    )
  );

  const dealsPromise = fetchAllPaginated(
    `${BASE}/deals?pipeline_id=${PIPELINE_VENDAS_ID}&status=all_not_deleted`
  );

  // Busca SEM start_date/end_date propositalmente no modo debug, pra não
  // arriscar cortar atividades por causa do filtro de due_date. Filtramos
  // tudo manualmente abaixo, usando marked_as_done_time.
  const activitiesPromise = fetchAllPaginated(`${BASE}/activities?done=1`);

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

  // --- Contadores de diagnóstico ---
  const diag = {
    total_activities_buscadas: activitiesResult.length,
    sem_done: 0,
    sem_deal_id: 0,
    deal_id_nao_encontrado_na_lista_de_deals: 0,
    sem_marked_as_done_time: 0,
    fora_do_intervalo_do_mes: 0,
    deal_sem_org: 0,
    deal_sem_owner: 0,
    contabilizadas: 0,
    amostra_atividades_ignoradas: [], // até 5 exemplos p/ inspecionar
  };

  function registrarAmostra(motivo, a) {
    if (diag.amostra_atividades_ignoradas.length < 10) {
      diag.amostra_atividades_ignoradas.push({
        motivo,
        id: a.id,
        done: a.done,
        deal_id: a.deal_id,
        marked_as_done_time: a.marked_as_done_time,
        due_date: a.due_date,
        type: a.type,
      });
    }
  }

  const orgsTrabalhadasPorOwner = new Map();
  for (const a of activitiesResult) {
    if (!a.done) {
      diag.sem_done++;
      registrarAmostra("sem_done", a);
      continue;
    }
    if (!a.deal_id) {
      diag.sem_deal_id++;
      registrarAmostra("sem_deal_id", a);
      continue;
    }
    if (!a.marked_as_done_time) {
      diag.sem_marked_as_done_time++;
      registrarAmostra("sem_marked_as_done_time", a);
      continue;
    }

    const quando = new Date(a.marked_as_done_time);
    if (quando < inicio || quando >= fim) {
      diag.fora_do_intervalo_do_mes++;
      registrarAmostra("fora_do_intervalo_do_mes", a);
      continue;
    }

    const deal = dealsPorId.get(a.deal_id);
    if (!deal) {
      diag.deal_id_nao_encontrado_na_lista_de_deals++;
      registrarAmostra("deal_id_nao_encontrado_na_lista_de_deals", a);
      continue;
    }
    if (!deal.org_id?.value) {
      diag.deal_sem_org++;
      registrarAmostra("deal_sem_org", a);
      continue;
    }

    const owner = deal.user_id?.value ?? deal.owner_id?.id;
    if (!owner) {
      diag.deal_sem_owner++;
      registrarAmostra("deal_sem_owner", a);
      continue;
    }

    diag.contabilizadas++;

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

  const resultado = {
    mes: nomeMesAtual(),
    gerado_em: new Date().toISOString(),
    total_carteira: total,
    total_abordados: abordados,
    pct_cobertura_geral: pct_geral,
    por_vendedor: porVendedor,
  };

  if (debug) {
    resultado._debug = {
      ...diag,
      total_deals_no_funil_vendas: dealsResult.length,
      intervalo_mes: { inicio: inicio.toISOString(), fim: fim.toISOString() },
    };
  }

  return resultado;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.has("refresh");
    const debug = url.searchParams.has("debug");

    // Modo debug sempre ignora cache, pra refletir a realidade agora.
    if (!debug && !forceRefresh && cache && Date.now() - cache.at < CACHE_MS) {
      return NextResponse.json({ ...cache.data, _cached: true });
    }
    const data = await calcular({ debug });
    if (data.erro) return NextResponse.json({ erro: data.erro }, { status: 500 });
    if (!debug) {
      cache = { at: Date.now(), data };
    }
    return NextResponse.json({ ...data, _cached: false });
  } catch (err) {
    return NextResponse.json(
      { erro: "Falha ao calcular cobertura.", detalhe: String(err) },
      { status: 502 }
    );
  }
}
