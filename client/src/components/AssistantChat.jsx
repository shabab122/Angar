import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ChefHat,
  LoaderCircle,
  MessageCircle,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import { currentBranch } from "../lib/branch";
import { assistantApi } from "../lib/assistant-api";
import { requestKey } from "../lib/api";
import { useResource } from "../lib/useResource";
import { ErrorMessage, Loading, Modal } from "./UI";

const prompts = [
  [
    "Highest-rated dishes",
    "সেরা রেটিংয়ের খাবার",
    "What are your highest-rated dishes?",
    "সবচেয়ে ভালো রেটিংয়ের খাবার কোনগুলো?",
  ],
  [
    "A meal within ৳500",
    "৫০০ টাকার মধ্যে",
    "Recommend food under ৳500 for 2 people.",
    "২ জনের জন্য ৫০০ টাকার মধ্যে খাবার দেখান।",
  ],
  ["Something mild", "কম ঝাল", "Show me mild dishes.", "কম ঝালের খাবার দেখান।"],
  [
    "Opening hours",
    "খোলার সময়",
    "What are your opening hours?",
    "আপনাদের খোলার সময় কখন?",
  ],
  [
    "How to order",
    "অর্ডার দেব কীভাবে",
    "How do I order from my table?",
    "টেবিল থেকে কীভাবে অর্ডার দেব?",
  ],
  [
    "Reserve a table",
    "টেবিল বুকিং",
    "How can I reserve a table?",
    "টেবিল বুক করব কীভাবে?",
  ],
];

export default function AssistantChat() {
  const app = useApp(),
    {
      t,
      language,
      online,
      customer,
      customerReady,
      contextReady,
      restaurant,
      setDishId,
      reloadMenu,
      money,
    } = app;
  const config = useResource("/assistant/config", { enabled: online });
  const [open, setOpen] = useState(false),
    [state, setState] = useState(null),
    [loading, setLoading] = useState(false),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [optimistic, setOptimistic] = useState("");
  const generation = useRef(0),
    controller = useRef(null),
    pending = useRef(null),
    input = useRef(null),
    end = useRef(null);
  const identity = currentBranch() + ":" + (customer?.id || "guest");
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    pending.current = null;
    setState(null);
    setDraft("");
    setError("");
    setBusy(false);
    setOptimistic("");
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [identity]);
  const load = useCallback(async () => {
    if (!online || !customerReady || !contextReady) return;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await assistantApi("");
      if (version === generation.current) setState(result);
    } catch (failure) {
      if (version === generation.current) setError(failure.message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [identity, online, customerReady, contextReady]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => {
    if (open)
      end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state?.conversation?.revision, optimistic, busy, open]);
  const send = async (question = draft) => {
    const message = question.trim();
    if (
      !message ||
      message.length > 600 ||
      busy ||
      loading ||
      !online ||
      !state?.enabled ||
      state.conversation.busy
    )
      return;
    const version = generation.current;
    const signature = JSON.stringify({ message, language, scope: state.scope });
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        data: {
          message,
          language,
          scope: state.scope,
          requestKey: requestKey(),
          expectedRevision: state.conversation.revision,
        },
      };
    const request = pending.current;
    controller.current = new AbortController();
    setBusy(true);
    setError("");
    setOptimistic(message);
    try {
      const result = await assistantApi("/messages", {
        data: request.data,
        signal: controller.current.signal,
        waitMs: (state.waitMs || 90000) + 10000,
      });
      if (version !== generation.current) return;
      setState((previous) => ({
        ...previous,
        conversation: result.conversation,
      }));
      setDraft("");
      pending.current = null;
    } catch (failure) {
      if (version !== generation.current || failure.code === "CANCELLED")
        return;
      setDraft(message);
      setError(failure.message);
      if (
        ["CHAT_UPDATED", "CHAT_BUSY", "CHAT_SCOPE_CHANGED"].includes(
          failure.code,
        )
      ) {
        pending.current = null;
        await load();
        setError(
          t(
            "Your chat or sign-in changed. Review the latest messages before sending again.",
            "Chat বা sign-in বদলেছে। আবার পাঠানোর আগে সর্বশেষ কথাগুলো দেখুন।",
          ),
        );
      }
      if (failure.code === "CHAT_DISABLED") {
        void config.reload();
        setOpen(false);
      }
    } finally {
      if (version === generation.current) {
        setBusy(false);
        setOptimistic("");
        controller.current = null;
      }
    }
  };
  const clear = async () => {
    if (busy || !state) return;
    const version = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await assistantApi("/clear", {
        data: {
          expectedRevision: state.conversation.revision,
          scope: state.scope,
        },
      });
      if (version === generation.current) {
        setState((previous) => ({
          ...previous,
          conversation: result.conversation,
        }));
        setDraft("");
        pending.current = null;
      }
    } catch (failure) {
      if (version === generation.current) {
        await load();
        setError(failure.message);
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  };
  async function viewDish(id) {
    await reloadMenu();
    setOpen(false);
    setDishId(id);
  }
  if (config.data?.enabled === false) return null;
  const turns = state?.conversation?.turns || [],
    ready = state?.ai?.state === "ready";
  return (
    <>
      <button
        className="assistant-launcher"
        type="button"
        aria-label={t("Open Angar Assistant", "আঙার সহকারী খুলুন")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        disabled={!customerReady || !contextReady}
      >
        <span className="assistant-launcher-icon">
          <MessageCircle size={23} />
        </span>
        <span>
          <strong>{t("Ask Angar", "আঙারকে জিজ্ঞেস করুন")}</strong>
          <small>{t("A little help choosing", "খাবার বাছতে একটু সাহায্য")}</small>
        </span>
        <Sparkles size={16} />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Angar Assistant", "আঙার সহকারী")}
        className="assistant-dialog"
      >
        <div className="assistant-shell">
          <div className="assistant-toolbar">
            <span className={"assistant-status" + (ready ? " ready" : "")}>
              <i />
              {ready
                ? t("Local AI ready", "Local AI প্রস্তুত")
                : t("Menu help", "মেনু সহায়তা")}
            </span>
            <span className="assistant-branch">{restaurant?.branch}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Refresh assistant", "সহকারী refresh করুন")}
              onClick={load}
              disabled={busy || loading}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Clear chat", "Chat মুছুন")}
              onClick={clear}
              disabled={busy || loading || !turns.length}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div
            className="assistant-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label={t("Assistant conversation", "সহকারীর সঙ্গে কথা")}
          >
            <div className="assistant-welcome">
              <span>
                <ChefHat size={28} />
              </span>
              <h3>
                {t(
                  "Good food starts with a little conversation.",
                  "ভালো খাবারের শুরু একটু কথায়।",
                )}
              </h3>
              <p>
                {t(
                  "Ask about this branch’s menu, guest ratings, your budget or planning your visit.",
                  "এই branch-এর মেনু, অতিথিদের রেটিং, আপনার বাজেট বা visit নিয়ে বলুন।",
                )}
              </p>
            </div>
            {loading && (
              <Loading label={t("Opening your chat…", "আপনার chat খুলছে…")} />
            )}
            {!loading && !turns.length && (
              <div className="assistant-prompts">
                {prompts.map(([en, bn, questionEn, questionBn]) => (
                  <button
                    type="button"
                    key={en}
                    disabled={busy || !online || !state?.enabled}
                    onClick={() => void send(t(questionEn, questionBn))}
                  >
                    {t(en, bn)}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
              </div>
            )}
            {turns.map((turn) => (
              <div key={turn.requestKey} className="assistant-turn">
                <div className="assistant-bubble user">
                  <small>{t("You", "আপনি")}</small>
                  <p>{turn.message}</p>
                </div>
                <article className="assistant-bubble answer">
                  <small>
                    <Sparkles size={12} />
                    {turn.mode === "ollama"
                      ? t("Angar · AI-assisted", "আঙার · AI সহায়তায়")
                      : t(
                          "Angar · Basic menu help",
                          "আঙার · সাধারণ মেনু সহায়তা",
                        )}
                  </small>
                  {turn.mode === "basic" && (
                    <p className="assistant-fallback">
                      {t(
                        "Local AI could not answer this time. This reply uses the restaurant’s basic menu guide.",
                        "এবার Local AI উত্তর দিতে পারেনি। এই উত্তর রেস্টুরেন্টের সাধারণ menu guide থেকে দেওয়া হয়েছে।",
                      )}
                    </p>
                  )}
                  <p>{turn.reply.text}</p>
                  {turn.reply.filters && (
                    <p className="assistant-filter-summary">
                      {t("For ", "সদস্য ")}
                      {turn.reply.filters.people}
                      {t(" · food budget ", " · খাবারের বাজেট ")}
                      {turn.reply.filters.budget === null
                        ? t("not set", "দেওয়া নেই")
                        : money(turn.reply.filters.budget)}
                      {turn.reply.filters.spice !== "any"
                        ? " · " +
                          t(
                            turn.reply.filters.spice,
                            {
                              mild: "কম ঝাল",
                              medium: "মাঝারি ঝাল",
                              hot: "বেশি ঝাল",
                            }[turn.reply.filters.spice],
                          )
                        : ""}
                    </p>
                  )}
                  {turn.reply.dishes.map((dish) => (
                    <div className="assistant-dish" key={dish.id}>
                      <div>
                        <strong>
                          {turn.reply.language === "bn"
                            ? dish.nameBn || dish.name
                            : dish.name}
                        </strong>
                        <b>
                          {money(dish.price)}
                          <small>{t(" base price", " মূল দাম")}</small>
                        </b>
                      </div>
                      <p>
                        {turn.reply.language === "bn"
                          ? dish.descriptionBn || dish.description
                          : dish.description}
                      </p>
                      <div className="assistant-dish-meta">
                        {dish.rating ? (
                          <span>
                            <Star size={12} />
                            {dish.rating.average.toFixed(2)} ·{" "}
                            {dish.rating.count}{" "}
                            {t("guest reviews", "অতিথি রিভিউ")}
                          </span>
                        ) : (
                          <span>
                            {t(
                              "No guest ratings yet",
                              "অতিথিদের রেটিং এখনো নেই",
                            )}
                          </span>
                        )}
                        <span>
                          {dish.available
                            ? t("Available", "পাওয়া যাচ্ছে")
                            : t("Sold out", "শেষ হয়ে গেছে")}
                        </span>
                      </div>
                      <div className="assistant-dish-bottom">
                        <span>
                          {dish.quantity}× · {money(dish.total)}
                          {dish.basis === "signature" && (
                            <small>
                              {t("House signature", "House signature")}
                            </small>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => void viewDish(dish.id)}
                          aria-label={
                            t("View dish ", "খাবার দেখুন ") + dish.name
                          }
                        >
                          {t("View dish", "খাবার দেখুন")}
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {turn.reply.dishes.length > 0 && (
                    <p className="assistant-price-note">
                      {t(
                        "Each card is a separate base-price option. Review current availability, sizes, add-ons and final charges before ordering.",
                        "প্রতিটি card আলাদা মূল-দামের option। অর্ডারের আগে বর্তমান প্রাপ্যতা, পরিমাণ, add-on ও চূড়ান্ত charge দেখুন।",
                      )}
                    </p>
                  )}
                  <div className="assistant-links">
                    {turn.reply.links.map((item) => (
                      <Link
                        to={item.to}
                        key={item.to}
                        onClick={() => setOpen(false)}
                      >
                        {item.label}
                        <ArrowUpRight size={12} />
                      </Link>
                    ))}
                  </div>
                </article>
              </div>
            ))}
            {optimistic && (
              <div className="assistant-bubble user">
                <small>{t("You", "আপনি")}</small>
                <p>{optimistic}</p>
              </div>
            )}
            {busy && optimistic && (
              <div className="assistant-wait" role="status">
                <LoaderCircle size={17} className="spin" />
                {t(
                  "Preparing your answer. Local AI can take a little time…",
                  "উত্তর প্রস্তুত হচ্ছে। Local AI-এর একটু সময় লাগতে পারে…",
                )}
              </div>
            )}
            {state?.conversation?.busy && !busy && (
              <p className="assistant-fallback">
                {t(
                  "Another tab is preparing an answer. Refresh this chat in a moment.",
                  "অন্য tab-এ উত্তর তৈরি হচ্ছে। একটু পরে এই chat refresh করুন।",
                )}
              </p>
            )}
            {error && <ErrorMessage>{error}</ErrorMessage>}
            {!online && (
              <p className="assistant-fallback">
                {t(
                  "Reconnect to the restaurant website to use chat.",
                  "Chat ব্যবহার করতে রেস্টুরেন্টের website-এ আবার সংযোগ করুন।",
                )}
              </p>
            )}
            <div ref={end} />
          </div>
          <form
            className="assistant-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="assistant-message">
              {t("Message to Angar Assistant", "আঙার সহকারীকে লিখুন")}
            </label>
            <div>
              <textarea
                id="assistant-message"
                ref={input}
                maxLength={600}
                rows={2}
                value={draft}
                disabled={
                  busy ||
                  !online ||
                  !state?.enabled ||
                  loading ||
                  state?.conversation?.busy
                }
                onChange={(event) => setDraft(event.target.value)}
                placeholder={t(
                  "Ask in English or বাংলা…",
                  "বাংলা বা English-এ লিখুন…",
                )}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                type="submit"
                aria-label={t("Send message", "প্রশ্ন পাঠান")}
                disabled={
                  busy ||
                  loading ||
                  !online ||
                  !state?.enabled ||
                  state?.conversation?.busy ||
                  !draft.trim()
                }
              >
                <Send size={19} />
              </button>
            </div>
            <p>
              <span>{draft.length}/600</span>
              {t(
                "Private chat · expires after 24h · clear anytime. Don’t send passwords or payment details.",
                "Private chat · ২৪ ঘণ্টা পরে মেয়াদ শেষ · মুছতে পারবেন। Password বা payment details পাঠাবেন না।",
              )}
            </p>
          </form>
        </div>
      </Modal>
    </>
  );
}
