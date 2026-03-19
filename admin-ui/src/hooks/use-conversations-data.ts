import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api";
import { sectionError } from "../lib/admin";
import type { ConversationDetail, ConversationFilters, ConversationSummary, NotifyFn } from "../types/admin";

export function useConversationsData(notify: NotifyFn) {
  const [filters, setFilters] = useState<ConversationFilters>({
    tenantId: "",
    source: "",
    search: ""
  });
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.tenantId) params.set("tenantId", filters.tenantId);
      if (filters.source) params.set("source", filters.source);
      if (filters.search) params.set("search", filters.search);
      params.set("limit", "50");
      const nextItems = await apiRequest<ConversationSummary[]>(
        `/api/admin/conversations?${params.toString()}`
      );
      setItems(nextItems);
      if (!selectedId && nextItems.length > 0) {
        setSelectedId(nextItems[0].conversationId);
      }
    } catch (caught) {
      notify({ type: "error", text: sectionError(caught) });
    } finally {
      setLoading(false);
    }
  }, [filters, notify, selectedId]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        setDetail(await apiRequest<ConversationDetail>(`/api/admin/conversations/${selectedId}`));
      } catch (caught) {
        notify({ type: "error", text: sectionError(caught) });
      }
    })();
  }, [notify, selectedId]);

  return {
    filters,
    items,
    selectedId,
    detail,
    loading,
    setFilters,
    setSelectedId,
    loadConversations
  };
}
