import { describe, it, expect, beforeEach } from "vitest";
import { MarketplaceAuthStore } from "../src/main/marketplace-auth-store";

describe("MarketplaceAuthStore", () => {
  let store: MarketplaceAuthStore;

  beforeEach(() => {
    const backing = new Map<string, unknown>();
    store = new MarketplaceAuthStore({
      get: (k) => backing.get(k),
      set: (k, v) => backing.set(k, v),
      delete: (k) => backing.delete(k),
      clearAll: () => backing.clear(),
    });
  });

  it("returns null when no token is stored", () => {
    expect(store.getToken()).toBeNull();
  });

  it("stores and retrieves a token", () => {
    store.setToken("abc123");
    expect(store.getToken()).toBe("abc123");
  });

  it("clears the token on signOut", () => {
    store.setToken("abc");
    store.signOut();
    expect(store.getToken()).toBeNull();
  });

  it("persists the user profile alongside the token", () => {
    store.setSession("tok", { id: "github:1", login: "u", avatar_url: "http://a" });
    expect(store.getUser()).toEqual({ id: "github:1", login: "u", avatar_url: "http://a" });
  });

  it("signOut clears user profile too", () => {
    store.setSession("tok", { id: "github:1", login: "u", avatar_url: "http://a" });
    store.signOut();
    expect(store.getUser()).toBeNull();
    expect(store.getToken()).toBeNull();
  });
});
