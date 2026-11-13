// News: headlines from the feeds the user added, newest first. Click a headline to open it in the browser.
import { HudPanel } from '../components/hud'
import { NATIVE } from '../lib/native'
import { go } from '../lib/nav'
import { ago, headlines, openLink, refreshNews, useNews } from '../lib/news'
import { feedsPref } from '../lib/prefs'

const hhmm = (d: Date | null) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'NEVER')

export function NewsScreen() {
  const feeds = feedsPref.use()
  const news = useNews()
  const list = headlines(news.results, feeds)
  const failed = Object.values(news.results).filter((r) => r.status === 'error').length

  return (
    <div className="screen screen-news">
      <HudPanel code="NWS-01" title="Headlines" className="news-main"
        status={news.refreshing ? { tone: 'ok', text: 'REFRESHING' } : list.length ? { tone: 'good', text: `${list.length} ITEMS` } : { tone: 'na', text: 'EMPTY' }}>
        <div className="toolbar">
          <span className="note">UPDATED {hhmm(news.lastRefresh)} · AUTO EVERY 30 MIN{failed ? ` · ${failed} FEED${failed > 1 ? 'S' : ''} FAILED` : ''}</span>
          <button type="button" className="btn" disabled={!NATIVE || news.refreshing || feeds.length === 0} onClick={() => void refreshNews()}>REFRESH</button>
        </div>
        {feeds.length === 0 ? (
          <div className="empty">
            <span className="empty-title">NO NEWS FEEDS ADDED</span>
            <span className="note">JARVIS shows only headlines from feeds you choose. Nothing is generated or summarised.</span>
            <button type="button" className="btn" onClick={() => go('settings')}>ADD FEEDS IN SETTINGS</button>
          </div>
        ) : !NATIVE ? (
          <div className="empty"><span className="empty-title">DESKTOP BUILD ONLY</span><span className="note">Feeds are fetched by the desktop app.</span></div>
        ) : list.length === 0 ? (
          <div className="empty"><span className="empty-title">{news.refreshing ? 'FETCHING FEEDS' : 'NO HEADLINES YET'}</span></div>
        ) : (
          <ul className="list headlines">
            {list.map((h, i) => (
              <li key={`${h.link ?? h.title}-${i}`}>
                <button type="button" className="row" disabled={!h.link} onClick={() => void openLink(h.link)} title={h.link ?? 'No link in feed'}>
                  <span className="row-time">{ago(h.at)}</span>
                  <span className="row-main">{h.title}</span>
                  <span className="row-sub">{h.source}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </HudPanel>

      <div className="screen-side">
        <HudPanel code="NWS-02" title="Feeds" className="grow" status={{ tone: feeds.length ? 'ok' : 'na', text: `${feeds.length} ADDED` }}>
          {feeds.length === 0 ? (
            <div className="empty"><span className="empty-title">NONE</span></div>
          ) : (
            <ul className="list">
              {feeds.map((f) => {
                const r = news.results[f.url]
                const tone = !r ? 'na' : r.status === 'error' ? 'bad' : r.status === 'loading' ? 'ok' : 'good'
                const text = !r ? 'NOT FETCHED' : r.status === 'error' ? 'FAILED' : r.status === 'loading' ? 'FETCHING' : `${r.items.length} ITEMS · ${hhmm(r.fetchedAt)}`
                return (
                  <li key={f.url} className="feed-row">
                    <span className="row-main">{f.name}</span>
                    <span className={`row-tag s-${tone}`}>{text}</span>
                    {r?.error && <span className="row-sub warn">{r.error}</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <button type="button" className="btn" onClick={() => go('settings')}>MANAGE FEEDS</button>
        </HudPanel>
        <HudPanel code="NWS-03" title="Source" className="fit" status={{ tone: 'ok', text: 'DIRECT' }}>
          <p className="note" style={{ margin: 0 }}>
            Fetched straight from each site over https. Headlines are shown exactly as the feed provides them.
          </p>
        </HudPanel>
      </div>
    </div>
  )
}
