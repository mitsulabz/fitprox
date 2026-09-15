<script lang="ts">
  import { theme, activeTab, session, authLoading, appData, persistSession, restoreSession, t } from "./lib/store";
  import { loadAppState, saveAppState, refreshToken, upsertProfile, retryPendingSave } from "./lib/supabase";
  import { migrateSportV13, trimPreJ1 } from "./lib/migrate";
  import { refreshSharedFoods } from "./lib/sharedFoods";
  import { needsBaseSetup } from "./lib/account";
  import AuthGate from "./lib/AuthGate.svelte";
  import BaseSetup from "./lib/BaseSetup.svelte";
  import BottomNav from "./lib/BottomNav.svelte";
  import Dashboard from "./lib/Dashboard.svelte";
  import Graph from "./lib/Graph.svelte";
  import Aliments from "./lib/Aliments.svelte";
  import Amis from "./lib/Amis.svelte";
  import Settings from "./lib/Settings.svelte";
  import { get } from "svelte/store";
  import { onMount } from "svelte";

  document.documentElement.setAttribute("data-theme", get(theme));

  // Migrations one-shot au chargement : V13 (sport programme → Sport cal) puis V13.1 (J1 au 22/06)
  function applyLoaded(s: NonNullable<typeof $session>, data: Record<string, unknown>) {
    const m = migrateSportV13(data);
    const t2 = trimPreJ1(m.data);
    appData.set(t2.data);
    if (m.changed || t2.changed) saveAppState(s.access_token, s.user.id, t2.data);
    refreshSharedFoods(s.access_token); // catalogue d'aliments commun (null si table absente)
  }

  async function loadData(s: typeof $session) {
    if (!s) return;
    const data = await loadAppState(s.access_token, s.user.id);
    if (data) {
      applyLoaded(s, data);
      upsertProfile(s.access_token, s.user.id, s.user.email);
    } else {
      try {
        const newSession = await refreshToken(s.refresh_token);
        persistSession(newSession);
        const retryData = await loadAppState(newSession.access_token, newSession.user.id);
        if (retryData) applyLoaded(newSession, retryData);
        else appData.set(retryData);
      } catch {
        persistSession(null);
      }
    }
  }

  onMount(async () => {
    // retour du réseau : rejoue la sauvegarde en attente s'il y en a une
    window.addEventListener('online', () => {
      const s = get(session);
      if (s) retryPendingSave(s.access_token, s.user.id);
    });
    const saved = restoreSession();
    if (saved) {
      session.set(saved);
      await loadData(saved);
    }
    authLoading.set(false);
  });

  let firstRun = true;
  session.subscribe(async (s) => {
    if (firstRun) { firstRun = false; return; }
    await loadData(s);
  });

  // Accueil « calories de départ » : compte non configuré (hors propriétaire)
  let setupClosed = $state(false);
  const showSetup = $derived(!setupClosed && needsBaseSetup($session?.user?.id ?? '', $appData));
</script>

{#if $authLoading}
  <div class="loading">{$t.common.loading}</div>
{:else if !$session}
  <AuthGate />
{:else}
  {#if $activeTab === "suivi"}<Dashboard />{/if}
  {#if $activeTab === "graph"}<Graph />{/if}
  {#if $activeTab === "aliments"}
    <Aliments />
  {/if}
  {#if $activeTab === "amis"}
    <Amis />
  {/if}
  {#if $activeTab === "reglages"}<Settings />{/if}
  <BottomNav />
  {#if showSetup}<BaseSetup firstRun={true} onclose={() => (setupClosed = true)} />{/if}
{/if}

<style>
.loading { flex:1; display:flex; align-items:center; justify-content:center; color:var(--c-text3); font-size:14px; }
</style>
