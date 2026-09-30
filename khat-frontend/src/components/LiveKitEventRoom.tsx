import { LiveKitRoom, RoomAudioRenderer, VideoConference } from '@livekit/components-react';
import '@livekit/components-styles';
import './LiveKitEventRoom.css';

export type LiveKitRoomAccess = {
  token: string;
  serverUrl: string;
  roomName: string;
};

export function LiveKitEventRoom({
  access,
  publishMedia,
  onConnected,
  onDisconnected,
  onError,
}: {
  access: LiveKitRoomAccess;
  publishMedia: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: Error) => void;
}) {
  return (
    <div className="livekit-event-room">
      <LiveKitRoom
        token={access.token}
        serverUrl={access.serverUrl}
        connect
        audio={publishMedia}
        video={publishMedia}
        options={{ adaptiveStream: true, dynacast: true }}
        data-lk-theme="default"
        onConnected={onConnected}
        onDisconnected={() => onDisconnected?.()}
        onError={onError}
      >
        <VideoConference />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}
