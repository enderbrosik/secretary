import { useEffect } from 'react';
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { legalDocs, parseInline, PUBLIC_SITE } from '../legal/content';
import { isDesktop, openExternal } from '../lib/platform';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) => {
        if ('text' in part) return <span key={i}>{part.text}</span>;
        if (part.href.startsWith('/'))
          return (
            <Link key={i} to={part.href} className="text-accent-text hover:underline">
              {part.label}
            </Link>
          );
        return (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent-text hover:underline"
            onClick={(e) => {
              if (!isDesktop) return;
              e.preventDefault();
              void openExternal(part.href);
            }}
          >
            {part.label}
          </a>
        );
      })}
    </>
  );
}

/** Privacy Policy / Terms of Service. Public: rendered whether or not you are signed in. */
export default function LegalPage({ doc: slug }: { doc: 'privacy' | 'terms' }) {
  const doc = legalDocs[slug];
  const other = slug === 'privacy' ? legalDocs.terms : legalDocs.privacy;
  useEffect(() => {
    document.title = `${doc.title} · Secretary`;
    window.scrollTo(0, 0);
    return () => {
      document.title = 'Secretary';
    };
  }, [doc.title]);

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
            <ArrowLeft className="size-4" />
            Back to Secretary
          </Link>
          <Link to={`/${other.slug}`} className="text-[13px] text-muted hover:text-ink">
            {other.title}
          </Link>
        </div>
        <article>
          <h1 className="font-display text-[32px] tracking-[-0.01em]">{doc.title}</h1>
          <p className="mt-1 text-[13px] text-faint">Last updated {doc.updated}</p>
          <div className="mt-6 space-y-3 text-[15px] leading-relaxed text-ink-2">
            {doc.intro.map((p) => (
              <p key={p}>
                <Inline text={p} />
              </p>
            ))}
          </div>
          {doc.sections.map((s) => (
            <section key={s.heading} className="mt-9">
              <h2 className="font-display text-[20px]">{s.heading}</h2>
              <div className="mt-3 space-y-3 text-[14.5px] leading-relaxed text-ink-2">
                {s.body.map((b, i) =>
                  typeof b === 'string' ? (
                    <p key={i}>
                      <Inline text={b} />
                    </p>
                  ) : (
                    <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-faint">
                      {b.list.map((li) => (
                        <li key={li}>
                          <Inline text={li} />
                        </li>
                      ))}
                    </ul>
                  ),
                )}
              </div>
            </section>
          ))}
        </article>
        <p className="mt-14 border-t border-line pt-5 text-[12.5px] text-faint">
          Also published at{' '}
          <Inline text={`[${PUBLIC_SITE.replace('https://', '')}/${doc.slug}](${PUBLIC_SITE}/${doc.slug}/)`} />
        </p>
      </div>
    </div>
  );
}
