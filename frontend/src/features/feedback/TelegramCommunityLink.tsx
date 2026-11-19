import { invoke, isTauri } from "@tauri-apps/api/core";
import { useState, type MouseEvent } from "react";
import { SiTelegram } from "react-icons/si";

const COMMUNITY_URL = "https://t.me/netrix_console";

export default function TelegramCommunityLink({ className, iconSize }: {
  className: string;
  iconSize: number;
}) {
  const [openFailed, setOpenFailed] = useState(false);

  async function openCommunity(event: MouseEvent<HTMLAnchorElement>) {
    if (!isTauri()) return;
    event.preventDefault();
    setOpenFailed(false);
    try {
      await invoke("open_telegram_community");
    } catch {
      setOpenFailed(true);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <a href={COMMUNITY_URL} target="_blank" rel="noopener noreferrer" className={className}
        onClick={openCommunity}
        onAuxClick={(event) => { if (event.button === 1) void openCommunity(event); }}
      >
        <SiTelegram size={iconSize} aria-hidden="true" />
        Join Our Telegram Community
      </a>
      {openFailed && (
        <p role="alert" className="text-center text-sm text-amber-300">
          Couldn’t open your browser. Open <span className="select-all">{COMMUNITY_URL}</span> manually.
        </p>
      )}
    </div>
  );
}
