import React from 'react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
export default function PropertyMap() {
  return (
    <div className="h-[400px] rounded-2xl overflow-hidden border border-white/10">
      {/* @ts-ignore - react-leaflet MapContainer center prop type error */}
      <MapContainer center={[42.36, -71.05]} zoom={13} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Marker position={[42.36, -71.05]} />
      </MapContainer>
    </div>
  );
}
