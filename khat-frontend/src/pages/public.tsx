import { useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, GraduationCap, Search, Users } from 'lucide-react';
import { pastCompetitionWinners, type GalleryWork } from '@/data/mock';
import { navigate, ShowcaseHeading, ShowcasePostCard, PenLoader } from '@/components/ui';
import { apiFetch, ApiError, getViewUrl } from '@/api';

type ApiShowcasePost = { 
  id: string; 
  user_role: string; 
  image_storage_key: string; 
  imageUrl?: string; // Resolved presigned view URL
  caption: string | null; 
  author_name: string; 
  branch_name?: string | null;
  branch?: string | null;
  like_count: string | number; 
  liked_by_me: boolean; 
  created_at: string;
};

export function Gallery() {
  const [posts, setPosts] = useState<ApiShowcasePost[]>([]);
  const [filter, setFilter] = useState<'all' | 'student' | 'teacher'>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchDraft.trim()); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: '12' });
    if (filter !== 'all') params.set('role', filter);
    if (search) params.set('q', search);
    setLoading(true);
    setError(null);
    apiFetch<{ items: ApiShowcasePost[]; total: number }>(`/showcase/feed?${params.toString()}`)
      .then(async result => {
        const visiblePosts = await Promise.all(result.items.map(async post => {
          if (!post.image_storage_key) return post;
          try { return { ...post, imageUrl: await getViewUrl(post.image_storage_key) }; }
          catch { return post; }
        }));
        if (!cancelled) {
          setPosts(visiblePosts);
          setTotal(result.total);
        }
      })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load gallery.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filter, page, search]);

  const pageCount = Math.max(1, Math.ceil(total / 12));
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);

  const toggleLike = async (post: ApiShowcasePost) => {
    try {
      const result = await apiFetch<{ likeCount: number; likedByMe: boolean }>(`/showcase/${post.id}/like`, { method: post.liked_by_me ? 'DELETE' : 'POST' });
      setPosts(current => current.map(item => item.id === post.id ? { ...item, like_count: result.likeCount, liked_by_me: result.likedByMe } : item));
    } catch { /* ignore */ }
  };

  const chooseFilter = (next: typeof filter) => { setFilter(next); setPage(1); };
  const firstResult = total === 0 ? 0 : (page - 1) * 12 + 1;
  const lastResult = Math.min(page * 12, total);

  return (
    <main className="page portal-page">
      <ShowcaseHeading
        title="Gallery" 
        text="Practice shared across every branch." 
        action={
          <button onClick={() => navigate('showcase')} className="text-link">
            Share your own <ArrowRight size={14} />
          </button>
        } 
      />
      {error && <p className="error-text">{error}</p>}
      <div className="gallery-feed-toolbar">
        <div className="gallery-feed-filters" role="group" aria-label="Filter gallery by showcase type">
          <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => chooseFilter('all')}>All work</button>
          <button type="button" className={filter === 'student' ? 'active' : ''} aria-pressed={filter === 'student'} onClick={() => chooseFilter('student')}><GraduationCap size={15} /> Student showcase</button>
          <button type="button" className={filter === 'teacher' ? 'active' : ''} aria-pressed={filter === 'teacher'} onClick={() => chooseFilter('teacher')}><Users size={15} /> Teacher showcase</button>
        </div>
        <label className="gallery-feed-search"><Search size={16} /><input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="Search work, artist, or branch…" aria-label="Search gallery work, artist, or branch" />{searchDraft && <button type="button" onClick={() => setSearchDraft('')} aria-label="Clear gallery search">×</button>}</label>
      </div>
      <div className="gallery-feed-summary"><span>{loading ? 'Loading showcase work…' : `${total.toLocaleString()} ${total === 1 ? 'piece' : 'pieces'}${filter === 'student' ? ' by students' : filter === 'teacher' ? ' by teachers' : ''}${search ? ` matching “${search}”` : ''}`}</span>{!loading && total > 0 && <span>Showing {firstResult.toLocaleString()}–{lastResult.toLocaleString()}</span>}</div>
      {loading ? <PenLoader label="Loading gallery…" compact /> : posts.length === 0 ? (
        <div className="gallery-feed-empty"><Search size={20} /><div><strong>{search ? 'No matching showcase work' : `No ${filter === 'student' ? 'student' : filter === 'teacher' ? 'teacher' : ''} showcase work yet`}</strong><p>{search ? 'Try a different search or clear the filters.' : 'New approved work will appear here when it is shared.'}</p></div></div>
      ) : <div className="gallery-grid gallery-feed-grid">{posts.map((post) => <ShowcasePostCard key={post.id} post={{
          id: post.id,
          role: post.user_role,
          imageUrl: post.imageUrl,
          caption: post.caption,
          authorName: post.author_name,
          branch: post.branch_name ?? post.branch,
          likes: Number(post.like_count),
          liked: post.liked_by_me,
        }} onLike={id => {
          const selected = posts.find(item => item.id === id);
          if (selected) void toggleLike(selected);
        }} />)}</div>}
      {!loading && pageCount > 1 && <nav className="gallery-feed-pagination" aria-label="Gallery pages"><button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1}><ChevronLeft size={16} /> Previous</button><span>Page {page} of {pageCount}</span><button type="button" onClick={() => setPage(current => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>Next <ChevronRight size={16} /></button></nav>}
    </main>
  );
}

export { pastCompetitionWinners };
export type { GalleryWork };