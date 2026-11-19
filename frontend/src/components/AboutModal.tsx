import React, { useEffect, useRef } from "react";
import { version as appVersion } from "../../package.json";
import TelegramCommunityLink from "../features/feedback/TelegramCommunityLink";
import {
    IoClose,
    IoFlash,
    IoHeart,
    IoLockClosed,
    IoPeople,
    IoRocketOutline,
    IoSparkles,
    IoTerminal,
} from "react-icons/io5";

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div className="ui-dialog relative w-full max-w-3xl mx-4 bg-[#0d1117] border border-white/[0.08] rounded-dialog shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto scrollbar-thin">
        {/* Decorative gradient glow */}
        <div className="absolute top-0 left-0 right-0 h-64 bg-gradient-to-b from-primary/[0.14] via-cyan-500/[0.07] to-transparent pointer-events-none" />
        <div className="absolute -top-28 -right-28 w-80 h-80 bg-primary/[0.1] rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -top-28 -left-28 w-80 h-80 bg-cyan-500/[0.07] rounded-full blur-3xl pointer-events-none" />

        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close About Netrix"
          className="absolute top-5 right-5 z-10 p-2 rounded-lg text-gray-500 hover:text-white hover:bg-white/[0.06] transition-all"
        >
          <IoClose size={22} />
        </button>

        <div className="relative px-6 py-8 sm:px-10">
          {/* Logo & title — centered, large */}
          <div className="flex flex-col items-center text-center mb-10">
            <img
              src="/icon.png"
              alt=""
              aria-hidden="true"
              width={96}
              height={96}
              draggable={false}
              className="mb-5 h-24 w-24 object-contain brightness-110"
            />
            <h2 className="text-4xl font-extrabold text-white leading-tight tracking-tight">
              Netrix
            </h2>
            <p className="text-lg text-gray-400 font-medium mt-2">
              Network Management Console
            </p>
            <p className="mt-2 font-mono text-xs text-gray-500">
              Version {appVersion}
            </p>
          </div>

          {/* AI badge — prominent */}
          <div className="flex items-center justify-center gap-4 px-7 py-4 mb-10 rounded-xl bg-gradient-to-r from-primary/[0.1] to-cyan-500/[0.08] border border-primary/[0.15]">
            <IoSparkles size={26} className="text-primary shrink-0" />
            <p className="text-[17px] text-blue-200 leading-relaxed">
              This entire project is <span className="font-bold text-primary">built with AI</span> — from architecture design and backend logic to every component and line of frontend code
            </p>
          </div>

          {/* Main motivational blocks */}
          <div className="space-y-7 mb-10">
            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/20">
                  <IoRocketOutline size={26} className="text-emerald-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">Your Ultimate Terminal Companion</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  <span className="text-white font-semibold">Netrix</span> is designed for anyone who works with terminal connections on a daily basis — whether you're a network engineer managing routers and switches at an ISP, a DevOps engineer SSHing into hundreds of servers, a system administrator maintaining infrastructure, or a developer who constantly needs remote access. Netrix brings SSH, Telnet, and serial connections together in one beautiful, organized workspace so you can focus on what matters.
                </p>
              </div>
            </div>

            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/20">
                  <IoFlash size={26} className="text-amber-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">Speed & Productivity First</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  Organize your hosts into groups, use Quick Connect for instant access, create reusable command snippets, and manage multiple sessions with tabbed terminals. Netrix saves you time by eliminating the hassle of remembering IPs, credentials, and connection parameters — everything is one click away.
                </p>
              </div>
            </div>

            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-sky-500/10 ring-1 ring-sky-500/20">
                  <IoLockClosed size={26} className="text-sky-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">Secure by Design</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  Your credentials never leave your machine. Netrix uses a local encrypted vault to store passwords and keys, with no cloud dependencies. All data stays on your device, giving you full control over your security — the way it should be for any serious network tool.
                </p>
              </div>
            </div>

            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-cyan-500/10 ring-1 ring-cyan-500/20">
                  <IoTerminal size={26} className="text-cyan-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">Modern Terminal Experience</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  Built as a native desktop application with a sleek, modern interface. Multiple terminal tabs, syntax highlighting, session logging, and customizable themes make your daily workflow not just efficient, but enjoyable. It's the terminal experience you've always wanted.
                </p>
              </div>
            </div>

            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-pink-500/10 ring-1 ring-pink-500/20">
                  <IoHeart size={26} className="text-pink-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">We Appreciate Every User</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  We're genuinely grateful to everyone who uses Netrix as part of their daily routine. Every user who trusts this tool with their workflow motivates us to keep improving. Your feedback, feature requests, and even bug reports are what drive this project forward — thank you for being part of this journey.
                </p>
              </div>
            </div>

            <div className="flex gap-5 items-start">
              <div className="shrink-0 mt-1">
                <div className="p-3 rounded-xl bg-violet-500/10 ring-1 ring-violet-500/20">
                  <IoPeople size={26} className="text-violet-400" />
                </div>
              </div>
              <div>
                <h3 className="text-[18px] font-bold text-white mb-2">Join & Contribute</h3>
                <p className="text-[15px] text-gray-400 leading-relaxed">
                  Want to help shape the future of Netrix? We welcome everyone — whether you want to suggest a feature, report an issue, contribute code, write documentation, or simply share Netrix with your colleagues. <span className="text-white font-semibold">Open source thrives on community, and every contribution matters.</span>
                </p>
              </div>
            </div>
          </div>

          {/* Telegram CTA */}
          <div className="flex justify-center mb-8">
            <TelegramCommunityLink
              className="flex items-center gap-3 px-8 py-3.5 bg-primary/10 hover:bg-primary/20 text-primary font-semibold text-[16px] rounded-xl transition-all ring-1 ring-primary/20 hover:ring-primary/40 hover:scale-[1.02]"
              iconSize={24}
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-center pt-6 border-t border-white/[0.06]">
            <p className="text-[13px] text-gray-500">
              Built with AI · Made with <IoHeart size={12} className="inline text-pink-500 mx-0.5 -mt-0.5" /> for terminal power users everywhere
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutModal;
