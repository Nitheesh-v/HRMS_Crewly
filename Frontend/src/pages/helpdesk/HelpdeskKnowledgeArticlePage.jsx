/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, FilePlus2 } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import { ArticleText, HelpdeskEmpty, HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import usePermission from '../../hooks/usePermission.js';
import { helpdeskData, helpdeskDateOnly, helpdeskErrorStatus, safeHelpdeskError } from './helpdeskFormat.js';

const HelpdeskKnowledgeArticlePage = () => {
  const { slug = '' } = useParams();
  const { hasPermission } = usePermission();
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const loadArticle = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const response = await helpdeskService.getKnowledgeBaseArticle(slug);
      if (requestRef.current !== requestId) return;
      setArticle(helpdeskData(response) || null);
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) setArticle(null);
      setError(safeHelpdeskError(requestError, 'This published article could not be loaded.'));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    setArticle(null);
    loadArticle();
    return () => { requestRef.current += 1; };
  }, [loadArticle]);

  if (loading) return <HelpdeskLoading label="Loading published article…" />;
  if (error) return <HelpdeskError message={error} onRetry={loadArticle} />;
  if (!article) return <HelpdeskEmpty icon={BookOpen} title="Article unavailable" detail="This article may have been unpublished or its audience access may have changed." action={<Link to="/app/helpdesk/knowledge-base" className="inline-flex min-h-9 items-center rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg">Back to Knowledge Base</Link>} />;

  return (
    <article className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><Link to="/app/helpdesk/knowledge-base" className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-medium hover:bg-crewly-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Knowledge Base</Link>{hasPermission('HELPDESK_TICKET_CREATE_SELF') ? <Link to={`/app/helpdesk/tickets/new${article.relatedQueueId ? `?queueId=${encodeURIComponent(article.relatedQueueId)}` : ''}`} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 hover:brightness-110"><FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />Create a ticket</Link> : null}</div>
      <section className="rounded-2xl border border-crewly-border bg-crewly-card p-5 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">{article.category?.name || 'Knowledge Base'}{article.publishedAt ? ` · Published ${helpdeskDateOnly(article.publishedAt)}` : ''}</p>
        <h1 className="mt-3 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{article.title}</h1>
        {article.summary ? <p className="mt-3 border-l-2 border-crewly-green/50 pl-4 text-sm leading-6 text-crewly-dim">{article.summary}</p> : null}
        <div className="my-6 border-t border-crewly-border" />
        <ArticleText>{article.body}</ArticleText>
        {article.relatedArticles?.length ? <section className="mt-8 border-t border-crewly-border pt-5" aria-labelledby="related-articles-title"><h2 id="related-articles-title" className="text-sm font-semibold">Related articles</h2><ul className="mt-3 grid gap-2 sm:grid-cols-2">{article.relatedArticles.map((related) => <li key={related.id}><Link to={`/app/helpdesk/knowledge-base/articles/${encodeURIComponent(related.slug)}`} className="block rounded-lg border border-crewly-border p-3 text-xs font-medium hover:border-crewly-green/40 hover:text-crewly-green">{related.title}{related.summary ? <span className="mt-1 block line-clamp-2 font-normal leading-5 text-crewly-dim">{related.summary}</span> : null}</Link></li>)}</ul></section> : null}
      </section>
      <div className="rounded-xl border border-crewly-border bg-crewly-bg/50 p-4 text-xs leading-5 text-crewly-dim">Still need help? {hasPermission('HELPDESK_TICKET_CREATE_SELF') ? <Link to={`/app/helpdesk/tickets/new${article.relatedQueueId ? `?queueId=${encodeURIComponent(article.relatedQueueId)}` : ''}`} className="font-semibold text-crewly-green hover:underline">Create a support ticket</Link> : <Link to="/app/helpdesk" className="font-semibold text-crewly-green hover:underline">Return to Helpdesk</Link>}.</div>
    </article>
  );
};

export default HelpdeskKnowledgeArticlePage;
