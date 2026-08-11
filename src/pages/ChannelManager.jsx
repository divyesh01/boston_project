import React, { useState } from "react";
import Card from "@/components/ui-exec/Card";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { RefreshCw, Link as LinkIcon, CheckCircle, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function ChannelManager() {
  const { property, properties } = useGlobalFilters();
  const [channels, setChannels] = useState([
    { id: "booking", name: "Booking.com", connected: false, lastSync: null },
    { id: "expedia", name: "Expedia", connected: false, lastSync: null },
    { id: "airbnb", name: "Airbnb", connected: false, lastSync: null },
  ]);
  const [syncing, setSyncing] = useState(false);
  const [logs, setLogs] = useState([]);
  
  const isPortfolio = property === "all" || Array.isArray(property);
  const propName = isPortfolio
    ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio")
    : (properties.find((p) => p.id === property)?.name || "Property");

  const handleConnect = async (channelId) => {
    const channelIndex = channels.findIndex(c => c.id === channelId);
    if (channelIndex === -1) return;
    
    const channel = channels[channelIndex];
    if (channel.connected) {
      // Disconnect
      const newChannels = [...channels];
      newChannels[channelIndex].connected = false;
      setChannels(newChannels);
      return;
    }

    try {
      await db.integrations.ChannelManager.Connect(channel.name, {});
      const newChannels = [...channels];
      newChannels[channelIndex].connected = true;
      setChannels(newChannels);
      addLog(`Successfully connected to ${channel.name}`);
    } catch (e) {
      addLog(`Failed to connect to ${channel.name}: ${e.message}`, true);
    }
  };

  const handleManualSync = async () => {
    if (isPortfolio) {
      addLog("Cannot sync portfolio. Please select a specific property.", true);
      return;
    }

    const connectedChannels = channels.filter(c => c.connected);
    if (connectedChannels.length === 0) {
      addLog("No channels connected to sync.", true);
      return;
    }

    setSyncing(true);
    try {
      // Fetch mock reservations from the SDK
      const reservations = await db.integrations.ChannelManager.PullReservations(property);
      addLog(`Pulled ${reservations.length} reservations from channels.`);
      
      // Save them to our local DB
      for (const res of reservations) {
        const existing = await db.entities.Reservation.filter({ confirmation_num: res.confirmation_num, property_id: property });
        if (existing && existing.length > 0) {
          await db.entities.Reservation.update(existing[0].id, {
            check_in: res.check_in,
            check_out: res.check_out,
            status: res.status,
            room_type_id: "Standard"
          });
        } else {
          await db.entities.Reservation.create({
            property_id: property,
            channel: res.channel,
            confirmation_num: res.confirmation_num,
            check_in: res.check_in,
            check_out: res.check_out,
            status: res.status,
            room_type_id: "Standard",
            created_date: new Date().toISOString()
          });
        }
      }
      
      // Push inventory out
      await db.integrations.ChannelManager.PushInventory(property, {});
      addLog(`Pushed updated inventory to channels.`);
      
      // Update last sync timestamps
      const now = new Date().toISOString();
      setChannels(channels.map(c => c.connected ? { ...c, lastSync: now } : c));
    } catch (e) {
      addLog(`Sync failed: ${e.message}`, true);
    } finally {
      setSyncing(false);
    }
  };

  const addLog = (msg, isError = false) => {
    const id = Date.now() + Math.random();
    setLogs(prev => [{ id, time: new Date().toLocaleTimeString(), msg, isError }, ...prev].slice(0, 10));
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6"
    >
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Module 6</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Channel Manager</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage OTA connections and perform two-way sync for {propName}.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="OTA Connections" subtitle="Connect your channel accounts to sync rates and availability.">
          <div className="space-y-4">
            {channels.map(channel => (
              <motion.div 
                key={channel.id} 
                whileHover={{ scale: 1.02 }}
                transition={{ type: "spring", stiffness: 300 }}
                className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0F1F35]/50 p-4"
              >
                <div className="flex items-center gap-3">
                  <motion.div 
                    layout
                    className={`flex h-10 w-10 items-center justify-center rounded-full ${channel.connected ? 'bg-green-500/10 text-green-400' : 'bg-slate-500/10 text-slate-400'}`}
                  >
                    {channel.connected ? <CheckCircle className="h-5 w-5" /> : <LinkIcon className="h-5 w-5" />}
                  </motion.div>
                  <div>
                    <h3 className="font-semibold text-white">{channel.name}</h3>
                    <p className="text-xs text-slate-400">
                      {channel.connected ? (channel.lastSync ? `Last sync: ${new Date(channel.lastSync).toLocaleTimeString()}` : 'Connected') : 'Not connected'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleConnect(channel.id)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    channel.connected
                      ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                      : 'bg-[#00D4FF]/10 text-[#00D4FF] hover:bg-[#00D4FF]/20'
                  }`}
                >
                  {channel.connected ? 'Disconnect' : 'Connect'}
                </button>
              </motion.div>
            ))}
          </div>
        </Card>

        <Card title="Sync Operations" subtitle="Manually trigger two-way syncs or view recent activity.">
          <div className="mb-6">
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleManualSync}
              disabled={syncing || isPortfolio}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#00D4FF] px-4 py-3 font-semibold text-[#0B1426] transition-colors hover:bg-[#00D4FF]/90 disabled:opacity-50"
            >
              <RefreshCw className={`h-5 w-5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing with OTAs...' : 'Run Manual Sync'}
            </motion.button>
            {isPortfolio && (
              <p className="mt-2 text-center text-xs text-amber-400 flex items-center justify-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Select a specific property to sync.
              </p>
            )}
          </div>
          
          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-300">Recent Sync Logs</h3>
            <div className="rounded-lg border border-white/5 bg-[#0F1F35]/50 p-4 h-48 overflow-y-auto font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-slate-500">No sync activity yet.</p>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={false}>
                    {logs.map((log) => (
                      <motion.li 
                        key={log.id} 
                        initial={{ opacity: 0, height: 0, scale: 0.9 }}
                        animate={{ opacity: 1, height: "auto", scale: 1 }}
                        className={log.isError ? 'text-red-400' : 'text-slate-300'}
                      >
                        <span className="text-slate-500">[{log.time}]</span> {log.msg}
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
