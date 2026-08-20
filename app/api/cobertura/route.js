import { NextResponse } from "next/server";
import { VENDEDORES, PIPELINE_VENDAS_ID } from "../../../lib/pipedrive-config";

const TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BASE = "https://api.pipedrive.com/v1";

// Cache em memória: guarda o resultado por 15 minutos para não ficar
// batendo na API do Pipedrive a cada refresh. Sobrevive por instância
// da função — em uso normal na Vercel, funciona bem.
let cache = null;

const CACHE_MS = 15 * 60 * 1000;

// Paginação dos endpoints antigos da Pipedrive: usa start/limit, não cursor.
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

function inicioMesAtualISO() {
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0);
  return inicio.toISOString();
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

  const orgsPromises = VENDEDORES.map((v) =>
    fetchAllPaginated(`${BASE}/organizations?user_id=${v.owner_id}`).then(
      (orgs) => ({ vendedor: v, orgs })
    )
  );
  const dealsPromise = fetchAllPaginated(
    `${BASE}/deals?pipeline_id=${PIPELINE_VENDAS_ID}&status=all_not_deleted`
  );

  const [dealsResult, ...orgsResults] = await Promise.all([
    dealsPromise,
    ...orgsPromises,
  ]);

  const inicioMes = inicioMesAtualISO();
  const dealsMes = dealsResult.filter(
    (d) => d.add_time && new Date(d.add_time) >= new Date(inicioMes)
  );

  const orgsPorVendedor = new Map();
  for (const { vendedor, orgs } of orgsResults) {
    orgsPorVendedor.set(vendedor.owner_id, {
      vendedor,
      orgs: new Map(orgs.map((o) => [o.id, o])),
    });
  }

  // Quais organizações receberam ao menos 1 negócio novo neste mês,
  // agrupado por dono do negócio.
  const orgsTrabalhadasPorOwner = new Map();
  for (const d of dealsMes) {
    if (!d.org_id?.value) continue;
    const owner = d.user_id?.value ?? d.owner_id?.id;
    if (!owner) continue;
    if (!orgsTrabalhadasPorOwner.has(owner)) {
      orgsTrabalhadasPorOwner.set(owner, new Set());
    }
    orgsTrabalhadasPorOwner.get(owner).add(d.org_id.value);
  }

  const porVendedor = VENDEDORES.map((v) => {
    const entrada = orgsPorVendedor.get(v.owner_id);
    const carteira = entrada.orgs;
    const trabalhadasGlobal =
      orgsTrabalhadasPorOwner.get(v.owner_id) ?? new Set();
    // Só conta como "trabalhada" quem faz parte da carteira atual dele.
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

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
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
