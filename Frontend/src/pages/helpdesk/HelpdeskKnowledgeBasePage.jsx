/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Search } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import { HelpdeskEmpty, HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import { helpdeskData, helpdeskDateOnly, helpdeskErrorStatus, helpdeskMeta, safeHelpdeskError } from './helpdeskFormat.js';

const HelpdeskKnowledgeBasePage = () => {
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [articles, setArticles] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const requestRef = useRef(0);
  const categoryNameById = new Map(categories.map((category) => [String(category.id), category.name]));

  const fetchArticles = useCallback(async ({ cursor = '', append = false } = {}) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const params = { limit: 20 };
      if (search) params.search = search;
      if (categoryId) params.categoryId = categoryId;
      if (cursor) params.cursor = cursor;
      const response = await helpdeskService.searchKnowledgeBase(params);
      if (requestRef.current !== requestId) return;
      const rows = Array.isArray(helpdeskData(response)) ? helpdeskData(response) : [];
      setArticles((current) => append ? [...current, ...rows] : rows);
      setMeta(helpdeskMeta(response));
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setArticles([]);
        setMeta(null);
      }
      setError(safeHelpdeskError(requestError, 'Published articles could not be loaded.'));
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [categoryId, search]);

  useEffect(() => {
    let alive = true;
    const loadCategories = async () => {
      setCategoryError('');
      try {
        const response = await helpdeskService.listKnowledgeBaseCategories();
        if (alive) setCategories(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
      } catch (requestError) {
        if (alive) {
          if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) setCategories([]);
          setCategoryError(safeHelpdeskError(requestError, 'Knowledge Base categories could not be loaded.'));
        }
      }
    };
    loadCategories();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setArticles([]);
    setMeta(null);
    fetchArticles();
    return () => { requestRef.current += 1; };
  }, [fetchArticles]);

  const applySearch = (event) => {
    event.preventDefault();
    const normalized = searchDraft.trim();
    if (normalized && normalized.length < 2) {
      setError('Use at least two characters to search.');
      return;
    }
    setSearch(normalized);
  };

  const loadMore = () => {
    if (meta?.nextCursor && !loadingMore) fetchArticles({ cursor: meta.nextCursor, append: true });
  };

  return (
    <section className="space-y-4" aria-labelledby="knowledge-base-title">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Published guidance</p><h2 id="knowledge-base-title" className="mt-1 text-xl font-semibold">Knowledge Base</h2><p className="mt-1 text-sm text-crewly-dim">Only articles your current account is authorized to read are returned.</p></div><span className="inline-flex items-center gap-2 rounded-lg border border-crewly-border bg-crewly-card px-3 py-2 text-xs text-crewly-dim"><BookOpen className="h-4 w-4 text-crewly-green" aria-hidden="true" />{articles.length} shown</span></div>

      {categoryError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="status">{categoryError}</p> : null}
      <form onSubmit={applySearch} className="grid gap-3 rounded-xl border border-crewly-border bg-crewly-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.5fr)_auto] sm:items-end" aria-label="Search the Knowledge Base">
        <label className="block text-xs font-medium text-crewly-dim">Search published articles<span className="relative mt-1.5 block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" aria-hidden="true" /><input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value.slice(0, 80))} maxLength={80} className="min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg pl-9 pr-3 text-sm text-crewly-text placeholder:text-crewly-dim/70 focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" placeholder="Search titles and summaries" /></span></label>
        <label className="block text-xs font-medium text-crewly-dim">Category<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20"><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-crewly-border px-4 text-xs font-semibold hover:bg-crewly-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green"><Search className="h-4 w-4" aria-hidden="true" />Search</button>
      </form>

      {loading ? <HelpdeskLoading label="Searching published articles…" /> : null}
      {!loading && error ? <HelpdeskError message={error} onRetry={() => fetchArticles()} /> : null}
      {!loading && !error && !articles.length ? <HelpdeskEmpty icon={BookOpen} title="No matching published articles" detail="Try a different search or category, or create a ticket if you still need help." /> : null}
      {!loading && articles.length ? <div className="grid gap-3 md:grid-cols-2">{articles.map((article) => <article key={article.id} className="flex min-w-0 flex-col rounded-xl border border-crewly-border bg-crewly-card p-4 transition hover:border-crewly-green/30"><p className="text-[10px] font-semibold uppercase tracking-wide text-crewly-green">{categoryNameById.get(String(article.categoryId)) || 'Help article'}{article.publishedAt ? ` · ${helpdeskDateOnly(article.publishedAt)}` : ''}</p><h3 className="mt-2 text-sm font-semibold"><Link to={`/app/helpdesk/knowledge-base/articles/${encodeURIComponent(article.slug)}`} className="hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">{article.title}</Link></h3>{article.summary ? <p className="mt-2 line-clamp-3 text-xs leading-5 text-crewly-dim">{article.summary}</p> : null}<Link to={`/app/helpdesk/knowledge-base/articles/${encodeURIComponent(article.slug)}`} className="mt-auto inline-flex min-h-9 items-center pt-3 text-xs font-semibold text-crewly-green hover:underline">Read article</Link></article>)}</div> : null}
      {!loading && meta?.nextCursor ? <div className="flex justify-center"><button type="button" onClick={loadMore} disabled={loadingMore} className="min-h-10 rounded-lg border border-crewly-border px-4 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50">{loadingMore ? 'Loading more…' : 'Load more articles'}</button></div> : null}
      <p className="text-[11px] leading-5 text-crewly-dim">Article visibility and queue access are determined by the server. No article content is stored in browser persistence.</p>
    </section>
  );
};

export default HelpdeskKnowledgeBasePage;
