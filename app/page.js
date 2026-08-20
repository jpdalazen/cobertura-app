"use client";

import { useEffect, useState } from "react";

function formatarQuando(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function VendorCard({ v }) {
  const [aberto, setAberto] = useState(false);

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-name">{v.vendedor}</h3>
        <span className="card-total">{v.total_carteira} clientes</span>
      </div>

      <div className="big-pct">{v.pct_cobertura}%</div>

      <div className="bar">
        <div
          className="bar-fill"
          style={{ width: `${v.pct_cobertura}%` }}
        />
      </div>

      <div className="card-meta">
        <span>
          <strong>{v.abordados}</strong> abordados
        </span>
        <span>
          <strong>{v.nao_abordados_qtd}</strong> não abordados
        </span>
      </div>

      <button className="toggle-list" onClick={() => setAberto(!aberto)}>
        {aberto ? "Esconder" : "Ver"} lista de não abordados
      </button>

      {aberto && (
        <div className="list">
          {v.nao_abordados.length === 0 ? (
            <div className="list-item">— Nenhum cliente pendente —</div>
          ) : (
            v.nao_abordados.map((o) => (
              <div key={o.id} className="list-item">
                {o.name}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);

  async function buscar(forcarNoCache = false) {
    setCarregando(true);
    setErro(null);
    try {
      const url = forcarNoCache
        ? `/api/cobertura?refresh=1&t=${Date.now()}`
        : "/api/cobertura";
      const resp = await fetch(url);
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro || "Falha ao carregar dados.");
      } else {
        setData(json);
      }
    } catch (e) {
      setErro("Falha de conexão.");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    buscar();
  }, []);

  if (carregando && !data) {
    return (
      <div className="page">
        <div className="loading">Carregando dados do Pipedrive…</div>
      </div>
    );
  }

  if (erro && !data) {
    return (
      <div className="page">
        <div className="error">{erro}</div>
        <button className="refresh" onClick={() => buscar(true)}>
          Tentar de novo
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">Cobertura de carteira</p>
          <h1>Painel de {data.mes}</h1>
          <p className="subtitle">
            % da carteira de cada vendedor que teve pelo menos 1 negócio novo
            criado neste mês, no funil de Vendas.
          </p>
        </div>
        <div className="actions">
          <button
            className="refresh"
            onClick={() => buscar(true)}
            disabled={carregando}
          >
            {carregando ? "Atualizando…" : "Atualizar agora"}
          </button>
        </div>
      </header>

      <section className="overall">
        <div>
          <div className="overall-label">Cobertura geral do time</div>
          <div className="overall-value">{data.pct_cobertura_geral}%</div>
        </div>
        <div className="overall-meta">
          <strong>{data.total_abordados}</strong> de{" "}
          <strong>{data.total_carteira}</strong> clientes trabalhados
          <br />
          Atualizado {formatarQuando(data.gerado_em)}
          {data._cached ? " (do cache, atualiza a cada 15 min)" : " (agora)"}
        </div>
      </section>

      <div className="grid">
        {data.por_vendedor.map((v) => (
          <VendorCard key={v.vendedor} v={v} />
        ))}
      </div>

      <footer className="footer">
        Dados diretos do Pipedrive · cache de 15 minutos · não considera
        Funil de Leads
      </footer>
    </div>
  );
}
