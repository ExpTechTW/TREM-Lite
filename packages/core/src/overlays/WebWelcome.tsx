import { useEffect, useRef } from "react";
import { Volume2 } from "lucide-react";

import icon from "../../../../apps/desktop/src-tauri/icons/128x128.png";
import { unlockSpeech } from "@/lib/speechClient";
import { webAudio } from "@/lib/webAudio";

const REPO = "https://github.com/ExpTechTW/TREM-Lite";

/**
 * The web's welcome, shown at every load and closed only by its button. A
 * browser plays no sound and speaks nothing until the page has been clicked,
 * so without this an EEW's alarm would be silent; the button's click is what
 * unlocks both (webAudio, speechClient). There is no other way out: no close
 * button, no backdrop click, no Esc.
 */
export function WebWelcome({ onStart }: { onStart: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);

  const start = () => {
    webAudio.unlock();
    unlockSpeech();
    onStart();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="web-welcome-title"
      className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-card/95 p-7 text-card-foreground shadow-2xl">
        <div className="flex items-center gap-4">
          <img src={icon} alt="" className="h-14 w-14 rounded-xl" />
          <div>
            <h1 id="web-welcome-title" className="text-2xl font-bold tracking-tight">
              TREM Lite
            </h1>
            <p className="text-sm text-muted-foreground">臺灣即時地震監測</p>
          </div>
        </div>

        <p className="mt-5 text-[15px] leading-relaxed">
          開源的地震速報軟體：以自建的測站網顯示各地即時震度，並在地震發生的第一時間，接收中央氣象署發布的強震即時警報與地震報告。
        </p>

        <div className="mt-4 flex gap-3 rounded-xl bg-white/5 p-3 text-sm leading-relaxed">
          <Volume2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span>瀏覽器要先點一下頁面才能發出聲音。按「開始使用」後，警報音效與語音播報才會啟用。</span>
        </div>

        <button
          ref={button}
          type="button"
          onClick={start}
          className="mt-6 w-full rounded-xl bg-primary py-3 text-base font-bold text-primary-foreground transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          開始使用
        </button>

        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 py-2.5 text-sm font-medium transition hover:bg-white/5"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub：原始碼與桌面版下載
        </a>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          資訊僅供參考，實際情況請以中央氣象署發布為準。
        </p>
      </div>
    </div>
  );
}
