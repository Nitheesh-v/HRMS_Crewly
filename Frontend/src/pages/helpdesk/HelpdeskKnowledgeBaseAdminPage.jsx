/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, Plus, RotateCcw, Save } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskEmpty, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import { helpdeskData, helpdeskDateTime, helpdeskErrorStatus, helpdeskMeta, safeHelpdeskError } from './helpdeskFormat.js';

const fieldClass = 'mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20';
const labelClass = 'block text-xs font-medium text-crewly-dim';
const emptyArticleForm = () => ({
  slug: '',
  title: '',
  summary: '',
  body: '',
  categoryId: '',
  relatedQueueId: '',
  visibility: 'employees',
  relatedArticleIdsText: '',
});

const articleToForm = (article) => {
  const content = article?.draftContent || article?.publishedContent || {};
  return {
    slug: article?.slug || '',
    title: content.title || '',
    summary: content.summary || '',
    body: content.body || '',
    categoryId: content.categoryId || '',
    relatedQueueId: content.relatedQueueId || '',
    visibility: content.visibility || 'employees',
    relatedArticleIdsText: (content.relatedArticleIds || []).join(', '),
  };
};

const HelpdeskKnowledgeBaseAdminPage = () => {
  const { hasPermission } = usePermission();
  const canPublish = hasPermission('HELPDESK_KB_PUBLISH');
  const [categories, setCategories] = useState([]);
  const [articles, setArticles] = useState([]);
  const [articleMeta, setArticleMeta] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [categoryError, setCategoryError] = useState('');
  const [articleError, setArticleError] = useState('');
  const [categoryNotice, setCategoryNotice] = useState('');
  const [articleNotice, setArticleNotice] = useState('');
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryForm, setCategoryForm] = useState({ name: '', slug: '', description: '', sortOrder: 0 });
  const [categoryEdits, setCategoryEdits] = useState({});
  const [pendingCategoryArchive, setPendingCategoryArchive] = useState(null);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [articleForm, setArticleForm] = useState(emptyArticleForm);
  const [articleBusy, setArticleBusy] = useState(false);
  const [pendingArticleAction, setPendingArticleAction] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [revisionMeta, setRevisionMeta] = useState(null);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [selectedRevision, setSelectedRevision] = useState(null);
  const requestRef = useRef(0);
  const categoryRequestRef = useRef(0);
  const articleDetailRequestRef = useRef(0);
  const revisionRequestRef = useRef(0);
  const accessEpochRef = useRef(0);

  const activeCategories = useMemo(() => categories.filter((category) => !category.archivedAt), [categories]);
  const categoryNameById = useMemo(() => new Map(categories.map((category) => [String(category.id), category.name])), [categories]);
  const clearRestrictedState = useCallback(() => {
    requestRef.current += 1;
    categoryRequestRef.current += 1;
    articleDetailRequestRef.current += 1;
    revisionRequestRef.current += 1;
    accessEpochRef.current += 1;
    setLoading(false);
    setLoadingMore(false);
    setCategoryBusy(false);
    setArticleBusy(false);
    setRevisionBusy(false);
    setCategoryError('');
    setArticleError('');
    setCategoryNotice('');
    setArticleNotice('');
    setCategories([]);
    setArticles([]);
    setArticleMeta(null);
    setCategoryForm({ name: '', slug: '', description: '', sortOrder: 0 });
    setCategoryEdits({});
    setPendingCategoryArchive(null);
    setSelectedArticle(null);
    setArticleForm(emptyArticleForm());
    setPendingArticleAction(null);
    setRevisions([]);
    setRevisionMeta(null);
    setSelectedRevision(null);
  }, []);

  const loadCategories = useCallback(async () => {
    const requestId = categoryRequestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    categoryRequestRef.current = requestId;
    setCategoryError('');
    try {
      const response = await helpdeskService.listAdminKnowledgeBaseCategories();
      if (categoryRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      setCategories(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
    } catch (requestError) {
      if (categoryRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setCategoryError(safeHelpdeskError(requestError, 'Knowledge Base categories could not be loaded.'));
    }
  }, [clearRestrictedState]);

  const loadArticles = useCallback(async ({ cursor = '', append = false } = {}) => {
    const requestId = requestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    requestRef.current = requestId;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setArticleError('');
    try {
      const params = { limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (categoryFilter) params.categoryId = categoryFilter;
      if (cursor) params.cursor = cursor;
      const response = await helpdeskService.listAdminKnowledgeBaseArticles(params);
      if (requestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      const rows = Array.isArray(helpdeskData(response)) ? helpdeskData(response) : [];
      setArticles((current) => append ? [...current, ...rows] : rows);
      setArticleMeta(helpdeskMeta(response));
    } catch (requestError) {
      if (requestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'Knowledge Base articles could not be loaded.'));
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [categoryFilter, clearRestrictedState, statusFilter]);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadCategories(), loadArticles()]);
    setLoading(false);
  }, [loadArticles, loadCategories]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    setArticles([]);
    setArticleMeta(null);
    loadArticles();
    return () => { requestRef.current += 1; };
  }, [loadArticles]);

  const createCategory = async (event) => {
    event.preventDefault();
    const accessEpoch = accessEpochRef.current;
    setCategoryBusy(true);
    setCategoryError('');
    setCategoryNotice('');
    try {
      const response = await helpdeskService.createKnowledgeBaseCategory({
        name: categoryForm.name.trim(),
        slug: categoryForm.slug.trim().toLowerCase(),
        description: categoryForm.description.trim(),
        sortOrder: Number(categoryForm.sortOrder),
      });
      if (accessEpochRef.current !== accessEpoch) return;
      const created = helpdeskData(response);
      setCategories((current) => [...current, created]);
      setCategoryForm({ name: '', slug: '', description: '', sortOrder: 0 });
      setCategoryNotice('Category created.');
    } catch (requestError) {
      if (accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setCategoryError(safeHelpdeskError(requestError, 'Category could not be created.'));
    } finally {
      setCategoryBusy(false);
    }
  };

  const saveCategory = async (category) => {
    const edit = categoryEdits[category.id] || { name: category.name, description: category.description, sortOrder: category.sortOrder };
    const accessEpoch = accessEpochRef.current;
    setCategoryBusy(true);
    setCategoryError('');
    setCategoryNotice('');
    try {
      const response = await helpdeskService.updateKnowledgeBaseCategory(category.id, {
        expectedVersion: category.version,
        name: edit.name.trim(),
        description: edit.description.trim(),
        sortOrder: Number(edit.sortOrder),
      });
      if (accessEpochRef.current !== accessEpoch) return;
      const updated = helpdeskData(response);
      setCategories((current) => current.map((item) => item.id === updated.id ? updated : item));
      setCategoryEdits((current) => { const next = { ...current }; delete next[category.id]; return next; });
      setCategoryNotice('Category updated.');
    } catch (requestError) {
      if (accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setCategoryError(safeHelpdeskError(requestError, 'Category changes could not be saved.'));
    } finally {
      setCategoryBusy(false);
    }
  };

  const archiveCategory = async (category) => {
    const accessEpoch = accessEpochRef.current;
    setCategoryBusy(true);
    setCategoryError('');
    setCategoryNotice('');
    try {
      const response = await helpdeskService.archiveKnowledgeBaseCategory(category.id, category.version);
      if (accessEpochRef.current !== accessEpoch) return;
      const updated = helpdeskData(response);
      setCategories((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPendingCategoryArchive(null);
      setCategoryNotice('Category archived.');
    } catch (requestError) {
      if (accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setCategoryError(safeHelpdeskError(requestError, 'Category could not be archived.'));
    } finally {
      setCategoryBusy(false);
    }
  };

  const newDraft = () => {
    articleDetailRequestRef.current += 1;
    revisionRequestRef.current += 1;
    setRevisionBusy(false);
    setSelectedArticle(null);
    setArticleForm({ ...emptyArticleForm(), categoryId: String(activeCategories[0]?.id || '') });
    setRevisions([]);
    setRevisionMeta(null);
    setSelectedRevision(null);
    setArticleError('');
    setArticleNotice('');
  };

  const openArticle = async (summary) => {
    const requestId = articleDetailRequestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    articleDetailRequestRef.current = requestId;
    revisionRequestRef.current += 1;
    setArticleBusy(true);
    setArticleError('');
    setArticleNotice('');
    setSelectedArticle(null);
    setArticleForm(emptyArticleForm());
    setSelectedRevision(null);
    setRevisionMeta(null);
    setRevisions([]);
    setRevisionBusy(false);
    try {
      const response = await helpdeskService.getAdminKnowledgeBaseArticle(summary.id);
      if (articleDetailRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      const article = helpdeskData(response);
      setSelectedArticle(article);
      setArticleForm(articleToForm(article));
      await loadRevisions(article.id);
    } catch (requestError) {
      if (articleDetailRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'Article details could not be loaded.'));
    } finally {
      if (articleDetailRequestRef.current === requestId) setArticleBusy(false);
    }
  };

  const loadRevisions = async (articleId) => {
    const requestId = revisionRequestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    revisionRequestRef.current = requestId;
    setRevisionBusy(true);
    try {
      const response = await helpdeskService.listKnowledgeBaseRevisions(articleId, { limit: 20 });
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      setRevisions(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
      setRevisionMeta(helpdeskMeta(response));
    } catch (requestError) {
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'Revision history could not be loaded.'));
    } finally {
      if (revisionRequestRef.current === requestId) setRevisionBusy(false);
    }
  };

  const loadMoreRevisions = async () => {
    if (!selectedArticle?.id || !revisionMeta?.nextCursor || revisionBusy) return;
    const requestId = revisionRequestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    revisionRequestRef.current = requestId;
    setRevisionBusy(true);
    try {
      const response = await helpdeskService.listKnowledgeBaseRevisions(selectedArticle.id, { limit: 20, cursor: revisionMeta.nextCursor });
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      setRevisions((current) => [...current, ...(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : [])]);
      setRevisionMeta(helpdeskMeta(response));
    } catch (requestError) {
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'Revision history could not be loaded.'));
    } finally {
      if (revisionRequestRef.current === requestId) setRevisionBusy(false);
    }
  };

  const updateForm = (field, value) => setArticleForm((current) => ({ ...current, [field]: value }));

  const buildArticlePayload = () => {
    const relatedArticleIds = articleForm.relatedArticleIdsText.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
    if (relatedArticleIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) throw new Error('Related article entries must be 24-character identifiers.');
    if (new Set(relatedArticleIds.map((id) => id.toLowerCase())).size !== relatedArticleIds.length) throw new Error('Related article identifiers must not be duplicated.');
    if (articleForm.visibility !== 'employees' && !articleForm.relatedQueueId.trim()) throw new Error('Queue-restricted articles need a queue identifier.');
    return {
      ...(selectedArticle ? {} : { slug: articleForm.slug.trim().toLowerCase() }),
      title: articleForm.title.trim(),
      summary: articleForm.summary.trim(),
      body: articleForm.body.trim(),
      categoryId: articleForm.categoryId,
      relatedQueueId: articleForm.visibility === 'employees' ? null : articleForm.relatedQueueId.trim(),
      visibility: articleForm.visibility,
      relatedArticleIds,
    };
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    const accessEpoch = accessEpochRef.current;
    setArticleError('');
    setArticleNotice('');
    try {
      const payload = buildArticlePayload();
      setArticleBusy(true);
      const response = selectedArticle
        ? await helpdeskService.updateKnowledgeBaseDraft(selectedArticle.id, { expectedVersion: selectedArticle.version, ...payload })
        : await helpdeskService.createKnowledgeBaseDraft(payload);
      if (accessEpochRef.current !== accessEpoch) return;
      const article = helpdeskData(response);
      setSelectedArticle(article);
      setArticleForm(articleToForm(article));
      setArticleNotice('Draft saved.');
      await loadArticles();
      if (accessEpochRef.current !== accessEpoch) return;
      await loadRevisions(article.id);
    } catch (requestError) {
      if (accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(helpdeskErrorStatus(requestError) ? safeHelpdeskError(requestError, 'Draft was not saved.') : String(requestError?.message || 'Draft was not saved.'));
    } finally {
      setArticleBusy(false);
    }
  };

  const runArticleAction = async () => {
    if (!selectedArticle || !pendingArticleAction) return;
    const accessEpoch = accessEpochRef.current;
    const { kind, revision } = pendingArticleAction;
    setArticleBusy(true);
    setArticleError('');
    setArticleNotice('');
    try {
      let response;
      if (kind === 'publish') response = await helpdeskService.publishKnowledgeBaseArticle(selectedArticle.id, selectedArticle.version);
      if (kind === 'archive') response = await helpdeskService.archiveKnowledgeBaseArticle(selectedArticle.id, selectedArticle.version);
      if (kind === 'restore') response = await helpdeskService.restoreKnowledgeBaseRevision(selectedArticle.id, revision, selectedArticle.version);
      if (accessEpochRef.current !== accessEpoch) return;
      const article = helpdeskData(response);
      setSelectedArticle(article);
      setArticleForm(articleToForm(article));
      setArticleNotice(kind === 'publish' ? 'Article published.' : kind === 'archive' ? 'Article archived.' : 'Revision restored as a draft.');
      setPendingArticleAction(null);
      await loadArticles();
      if (accessEpochRef.current !== accessEpoch) return;
      await loadRevisions(article.id);
    } catch (requestError) {
      if (accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'The Knowledge Base action could not be completed.'));
    } finally {
      setArticleBusy(false);
    }
  };

  const inspectRevision = async (revision) => {
    if (!selectedArticle?.id) return;
    const requestId = revisionRequestRef.current + 1;
    const accessEpoch = accessEpochRef.current;
    const articleId = selectedArticle.id;
    revisionRequestRef.current = requestId;
    setRevisionBusy(true);
    setSelectedRevision(null);
    try {
      const response = await helpdeskService.getKnowledgeBaseRevision(articleId, revision.revision);
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      setSelectedRevision(helpdeskData(response));
    } catch (requestError) {
      if (revisionRequestRef.current !== requestId || accessEpochRef.current !== accessEpoch) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setArticleError(safeHelpdeskError(requestError, 'Revision details could not be loaded.'));
    } finally {
      if (revisionRequestRef.current === requestId) setRevisionBusy(false);
    }
  };

  if (loading && !categories.length && !articles.length) return <HelpdeskLoading label="Loading Knowledge Base administration…" />;

  return (
    <section className="space-y-4" aria-labelledby="kb-admin-title">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Knowledge Base governance</p><h2 id="kb-admin-title" className="mt-1 text-xl font-semibold">Knowledge Base management</h2><p className="mt-1 text-sm text-crewly-dim">Drafts and publication history stay in component memory only; the server validates every transition and version.</p></div><div className="flex gap-2"><button type="button" onClick={reloadAll} disabled={loading} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50">Refresh</button><button type="button" onClick={newDraft} disabled={articleBusy} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" />New article draft</button></div></div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(18rem,0.78fr)_minmax(0,1.22fr)]">
        <div className="space-y-4">
          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4" aria-labelledby="kb-category-admin-title"><h3 id="kb-category-admin-title" className="text-sm font-semibold">Categories</h3>{categoryError ? <p className="mt-2 text-xs text-rose-100" role="alert">{categoryError}</p> : null}{categoryNotice ? <p className="mt-2 text-xs text-emerald-100" role="status">{categoryNotice}</p> : null}
            <form onSubmit={createCategory} className="mt-3 grid gap-2 rounded-lg border border-crewly-border bg-crewly-bg/40 p-3 sm:grid-cols-2"><label className={labelClass}>Name<input value={categoryForm.name} onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value.slice(0, 80) }))} maxLength={80} required className={fieldClass} /></label><label className={labelClass}>Slug<input value={categoryForm.slug} onChange={(event) => setCategoryForm((current) => ({ ...current, slug: event.target.value.slice(0, 80) }))} maxLength={80} required className={fieldClass} placeholder="account-access" /></label><label className={`${labelClass} sm:col-span-2`}>Description<input value={categoryForm.description} onChange={(event) => setCategoryForm((current) => ({ ...current, description: event.target.value.slice(0, 300) }))} maxLength={300} className={fieldClass} /></label><label className={labelClass}>Sort order<input type="number" min="0" max="10000" value={categoryForm.sortOrder} onChange={(event) => setCategoryForm((current) => ({ ...current, sortOrder: event.target.value }))} className={fieldClass} /></label><button type="submit" disabled={categoryBusy} className="mt-auto inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-crewly-border text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Create category</button></form>
            <ul className="mt-3 space-y-2">{categories.map((category) => { const edit = categoryEdits[category.id] || { name: category.name, description: category.description, sortOrder: category.sortOrder }; const dirty = edit.name !== category.name || edit.description !== category.description || Number(edit.sortOrder) !== Number(category.sortOrder); return <li key={category.id} className={`rounded-lg border p-3 ${category.archivedAt ? 'border-crewly-border/50 opacity-70' : 'border-crewly-border'}`}><div className="grid gap-2 sm:grid-cols-2"><label className={labelClass}>Name<input value={edit.name} disabled={Boolean(category.archivedAt)} onChange={(event) => setCategoryEdits((current) => ({ ...current, [category.id]: { ...edit, name: event.target.value.slice(0, 80) } }))} maxLength={80} className={fieldClass} /></label><label className={labelClass}>Description<input value={edit.description} disabled={Boolean(category.archivedAt)} onChange={(event) => setCategoryEdits((current) => ({ ...current, [category.id]: { ...edit, description: event.target.value.slice(0, 300) } }))} maxLength={300} className={fieldClass} /></label><label className={labelClass}>Sort order<input type="number" min="0" max="10000" value={edit.sortOrder ?? 0} disabled={Boolean(category.archivedAt)} onChange={(event) => setCategoryEdits((current) => ({ ...current, [category.id]: { ...edit, sortOrder: event.target.value } }))} className={fieldClass} /></label><div className="flex items-end justify-end gap-2"><button type="button" onClick={() => saveCategory(category)} disabled={!dirty || categoryBusy || Boolean(category.archivedAt)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-40"><Save className="h-3.5 w-3.5" aria-hidden="true" />Save</button>{category.archivedAt ? <span className="pb-2 text-[10px] text-crewly-dim">Archived</span> : <button type="button" onClick={() => setPendingCategoryArchive(category)} disabled={categoryBusy} className="min-h-9 rounded-lg border border-rose-300/15 px-3 text-xs font-semibold text-rose-100 hover:bg-rose-300/5 disabled:opacity-50">Archive</button>}</div></div>{pendingCategoryArchive?.id === category.id ? <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3" role="alertdialog" aria-label="Confirm category archive"><p className="text-xs text-amber-100">Archive “{category.name}”? The server will reject this if active articles still reference it.</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => setPendingCategoryArchive(null)} className="min-h-8 rounded-lg border border-crewly-border px-3 text-[11px]">Cancel</button><button type="button" onClick={() => archiveCategory(category)} disabled={categoryBusy} className="min-h-8 rounded-lg bg-amber-200 px-3 text-[11px] font-semibold text-slate-950 disabled:opacity-50">Confirm archive</button></div></div> : null}</li>; })}</ul>
          </section>

          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4" aria-labelledby="kb-article-list-title"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="kb-article-list-title" className="text-sm font-semibold">Articles</h3><button type="button" onClick={() => loadArticles()} className="text-xs font-semibold text-crewly-green hover:underline">Refresh</button></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className={labelClass}>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={fieldClass}><option value="">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label><label className={labelClass}>Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className={fieldClass}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}{category.archivedAt ? ' (archived)' : ''}</option>)}</select></label></div>{articleError ? <p className="mt-3 text-xs text-rose-100" role="alert">{articleError}</p> : null}{loading ? <div className="py-4"><HelpdeskLoading label="Loading articles…" /></div> : null}{!loading && !articles.length ? <div className="mt-3"><HelpdeskEmpty icon={BookOpen} title="No articles in this view" detail="Create a draft or change the filters." /></div> : null}<ul className="mt-3 divide-y divide-crewly-border rounded-lg border border-crewly-border">{articles.map((article) => <li key={article.id}><button type="button" onClick={() => openArticle(article)} disabled={articleBusy} className={`w-full p-3 text-left hover:bg-crewly-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crewly-green disabled:cursor-wait disabled:opacity-50 ${selectedArticle?.id === article.id ? 'bg-crewly-green/5' : ''}`}><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-xs font-semibold text-crewly-text">{article.title || article.slug}</span><span className="mt-1 block truncate text-[10px] text-crewly-dim">{article.slug} · {categoryNameById.get(String(article.categoryId)) || 'No category'} · v{article.version}</span></span><span className="shrink-0 rounded-full border border-crewly-border px-2 py-0.5 text-[10px] capitalize text-crewly-dim">{article.status}</span></span></button></li>)}</ul>{articleMeta?.nextCursor ? <button type="button" onClick={() => loadArticles({ cursor: articleMeta.nextCursor, append: true })} disabled={loadingMore} className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-crewly-border text-xs font-semibold disabled:opacity-50"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />{loadingMore ? 'Loading…' : 'Load more'}</button> : null}</section>
        </div>

        <div className="space-y-4">
          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5" aria-labelledby="kb-draft-editor-title"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">{selectedArticle ? `${selectedArticle.status} · version ${selectedArticle.version}` : 'New draft'}</p><h3 id="kb-draft-editor-title" className="mt-1 text-base font-semibold">{selectedArticle ? 'Article editor' : 'Create an article draft'}</h3><p className="mt-1 text-[11px] leading-5 text-crewly-dim">Plain text only. Queue and article references are validated again by the server.</p></div>{selectedArticle ? <span className="text-[10px] text-crewly-dim">Updated {helpdeskDateTime(selectedArticle.updatedAt)}</span> : null}</div>
            {articleNotice ? <p className="mt-3 rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-xs text-emerald-100" role="status">{articleNotice}</p> : null}{articleError ? <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-100" role="alert">{articleError}</p> : null}
            {pendingArticleAction ? <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3" role="alertdialog" aria-labelledby="kb-action-confirm-title"><h4 id="kb-action-confirm-title" className="text-xs font-semibold text-amber-50">Confirm {pendingArticleAction.kind}?</h4><p className="mt-1 text-[11px] leading-5 text-amber-50/80">This transition is recorded by the backend and uses the currently loaded version to prevent stale writes.</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => setPendingArticleAction(null)} className="min-h-8 rounded-lg border border-amber-100/20 px-3 text-[11px] text-amber-50">Cancel</button><button type="button" onClick={runArticleAction} disabled={articleBusy} className="min-h-8 rounded-lg bg-amber-200 px-3 text-[11px] font-semibold capitalize text-slate-950 disabled:opacity-50">{articleBusy ? 'Working…' : `Confirm ${pendingArticleAction.kind}`}</button></div></div> : null}
            {articleBusy && !selectedArticle ? <HelpdeskLoading label="Loading article details…" /> : null}
            <form onSubmit={saveDraft} className="mt-4 space-y-3">
              {!selectedArticle ? <label className={labelClass}>Stable slug<input value={articleForm.slug} onChange={(event) => updateForm('slug', event.target.value.slice(0, 80))} maxLength={80} required className={fieldClass} placeholder="account-access" /></label> : <div className="rounded-lg border border-crewly-border bg-crewly-bg/40 p-3 text-xs"><span className="text-crewly-dim">Stable slug</span><code className="mt-1 block break-all text-crewly-text">{selectedArticle.slug}</code></div>}
              <label className={labelClass}>Title<input value={articleForm.title} onChange={(event) => updateForm('title', event.target.value.slice(0, 120))} maxLength={120} required className={fieldClass} /></label>
              <label className={labelClass}>Summary<textarea value={articleForm.summary} onChange={(event) => updateForm('summary', event.target.value.slice(0, 500))} maxLength={500} rows={2} className={`${fieldClass} resize-y`} /></label>
              <label className={labelClass}>Article body<textarea value={articleForm.body} onChange={(event) => updateForm('body', event.target.value.slice(0, 5000))} maxLength={5000} rows={9} required className={`${fieldClass} resize-y`} /><span className="mt-1 block text-right text-[10px] text-crewly-dim">{articleForm.body.length}/5000 characters · plain text</span></label>
              <div className="grid gap-3 sm:grid-cols-2"><label className={labelClass}>Category<select value={articleForm.categoryId} onChange={(event) => updateForm('categoryId', event.target.value)} required className={fieldClass}><option value="">Select category</option>{activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className={labelClass}>Audience<select value={articleForm.visibility} onChange={(event) => updateForm('visibility', event.target.value)} className={fieldClass}><option value="employees">Employees</option><option value="queue_staff">Queue staff</option><option value="confidential_queue_staff">Confidential queue staff</option></select></label></div>
              {articleForm.visibility !== 'employees' ? <label className={labelClass}>Related queue identifier<input value={articleForm.relatedQueueId} onChange={(event) => updateForm('relatedQueueId', event.target.value.slice(0, 24))} maxLength={24} required className={fieldClass} placeholder="24-character queue ID" /><span className="mt-1 block text-[10px] text-crewly-dim">This Helpdesk contract does not provide a queue picker to Knowledge Base managers; the server validates the tenant-scoped ID and visibility.</span></label> : null}
              <label className={labelClass}>Related article identifiers <span className="font-normal">(optional)</span><input value={articleForm.relatedArticleIdsText} onChange={(event) => updateForm('relatedArticleIdsText', event.target.value.slice(0, 300))} className={fieldClass} placeholder="Comma-separated article IDs" /><span className="mt-1 block text-[10px] text-crewly-dim">Up to 10 related articles; references are revalidated by the server.</span></label>
              <div className="flex flex-wrap justify-end gap-2 border-t border-crewly-border pt-3"><button type="button" onClick={newDraft} disabled={articleBusy} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">Clear editor</button><button type="submit" disabled={articleBusy || !activeCategories.length} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50"><Save className="h-3.5 w-3.5" aria-hidden="true" />{articleBusy ? 'Saving…' : 'Save draft'}</button></div>
            </form>
            {selectedArticle ? <div className="mt-4 flex flex-wrap gap-2 border-t border-crewly-border pt-4">{selectedArticle.status !== 'archived' && canPublish ? <button type="button" onClick={() => setPendingArticleAction({ kind: 'publish' })} disabled={articleBusy} className="min-h-9 rounded-lg border border-emerald-300/20 px-3 text-xs font-semibold text-emerald-100 hover:bg-emerald-300/5 disabled:opacity-50">Publish</button> : null}{selectedArticle.status !== 'archived' ? <button type="button" onClick={() => setPendingArticleAction({ kind: 'archive' })} disabled={articleBusy} className="min-h-9 rounded-lg border border-rose-300/20 px-3 text-xs font-semibold text-rose-100 hover:bg-rose-300/5 disabled:opacity-50">Archive</button> : null}<button type="button" onClick={() => loadRevisions(selectedArticle.id)} disabled={revisionBusy || articleBusy} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">{revisionBusy ? 'Loading revisions…' : 'Refresh revisions'}</button></div> : null}
            {selectedArticle && selectedArticle.status !== 'archived' && !canPublish ? <p className="mt-2 text-[10px] leading-4 text-crewly-dim">Publishing requires the separate Helpdesk Knowledge Base publish permission.</p> : null}
          </section>

          {selectedArticle ? <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4" aria-labelledby="kb-revisions-title"><div className="flex items-center justify-between gap-2"><h3 id="kb-revisions-title" className="text-sm font-semibold">Publication history</h3><span className="text-[10px] text-crewly-dim">{revisions.length} revision(s)</span></div>{revisionBusy && !revisions.length ? <HelpdeskLoading label="Loading revision history…" /> : null}{!revisionBusy && !revisions.length ? <p className="mt-3 text-xs text-crewly-dim">No published revisions are available yet.</p> : null}<ul className="mt-3 space-y-2">{revisions.map((revision) => <li key={revision.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-crewly-border p-3"><div className="min-w-0"><p className="truncate text-xs font-semibold">Revision {revision.revision}: {revision.title}</p><p className="mt-1 text-[10px] text-crewly-dim">Published {helpdeskDateTime(revision.publishedAt)} · source draft {revision.sourceDraftRevision}</p></div><div className="flex gap-2"><button type="button" onClick={() => inspectRevision(revision)} disabled={revisionBusy} className="min-h-8 rounded-lg border border-crewly-border px-2.5 text-[10px] font-semibold">View</button><button type="button" onClick={() => setPendingArticleAction({ kind: 'restore', revision: revision.revision })} disabled={articleBusy} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-crewly-border px-2.5 text-[10px] font-semibold"><RotateCcw className="h-3 w-3" aria-hidden="true" />Restore</button></div></li>)}</ul>{revisionMeta?.nextCursor ? <button type="button" onClick={loadMoreRevisions} disabled={revisionBusy} className="mt-3 min-h-8 w-full rounded-lg border border-crewly-border text-xs font-semibold disabled:opacity-50">Load more revisions</button> : null}{selectedRevision ? <div className="mt-4 rounded-lg border border-crewly-green/20 bg-crewly-green/5 p-3"><div className="flex items-start justify-between gap-3"><h4 className="text-xs font-semibold">Revision {selectedRevision.revision}: {selectedRevision.title}</h4><button type="button" onClick={() => setSelectedRevision(null)} className="text-[10px] text-crewly-dim underline">Close</button></div>{selectedRevision.content?.summary ? <p className="mt-2 text-xs text-crewly-dim">{selectedRevision.content.summary}</p> : null}<p className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-crewly-text">{selectedRevision.content?.body || 'No revision body.'}</p></div> : null}</section> : null}
        </div>
      </div>
      <p className="text-[10px] leading-4 text-crewly-dim">Visibility, audience membership, publication eligibility, and revision compare-and-swap versions are checked by the Helpdesk API. No frontend tenant identity or storage keys are sent.</p>
    </section>
  );
};

export default HelpdeskKnowledgeBaseAdminPage;
