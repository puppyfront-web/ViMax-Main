"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientWsMessage,
  ServerWsMessage,
} from "@vimax/contracts";

// ── WebSocket Client Hook ───────────────────────────────────────────
// Manages a persistent WebSocket connection to the ViMax API server.
// Provides methods to send chat messages and subscribe to canvas events.

interface UseCanvasWebSocketOptions {
  canvasId: string;
  /** Callback when a server message is received */
  onMessage?: (msg: ServerWsMessage) => void;
  /** Whether to auto-connect (default: true) */
  enabled?: boolean;
}

interface UseCanvasWebSocketReturn {
  /** Current connection state */
  status: "connecting" | "connected" | "disconnected" | "error";
  /** Send a message to the server */
  send: (msg: ClientWsMessage) => void;
  /** Last error message */
  error: string | null;
  /** Manually reconnect */
  reconnect: () => void;
}

function getWsUrl(): string {
  const apiBase = (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/trpc\/?$/, "") ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
  return apiBase.replace(/^http/, "ws") + "/ws";
}

export function useCanvasWebSocket({
  canvasId,
  onMessage,
  enabled = true,
}: UseCanvasWebSocketOptions): UseCanvasWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("disconnected");
  const [error, setError] = useState<string | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!enabled || !canvasId) return;

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const url = getWsUrl();
    setStatus("connecting");
    setError(null);

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        reconnectAttemptsRef.current = 0;
        setError(null);

        // Subscribe to canvas room
        const subscribeMsg: ClientWsMessage = {
          type: "chat.subscribe",
          canvasId,
        };
        ws.send(JSON.stringify(subscribeMsg));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerWsMessage;
          onMessageRef.current?.(msg);
        } catch (err) {
          console.error("[ws] Failed to parse message:", err);
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
        wsRef.current = null;

        // Auto-reconnect with exponential backoff (max 30s)
        if (enabled) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            30000,
          );
          reconnectAttemptsRef.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection error");
        console.error(
          `[ws] Connection error — url=${url} readyState=${ws.readyState}`,
        );
      };
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to connect");
    }
  }, [canvasId, enabled]);

  const send = useCallback(
    (msg: ClientWsMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      } else {
        console.warn("[ws] Cannot send: not connected");
      }
    },
    [],
  );

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    connect();
  }, [connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatus("disconnected");
    };
  }, [connect]);

  return { status, send, error, reconnect };
}
