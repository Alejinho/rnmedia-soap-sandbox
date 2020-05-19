/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 * @flow strict-local
 */

import React, {useEffect, useState} from 'react';
import {
  ScrollView,
  Text,
  Button,
  Platform,
  Dimensions,
  PermissionsAndroid,
} from 'react-native';

import {RTCView} from 'react-native-webrtc';

import {
  main,
  joinRoom,
  pullItems,
  onLeave,
  getPeerStreams,
  subscribeToTrack,
  sendCameraStreams,
} from './client';

function App() {
  const [opt, setOpt] = useState({});
  const [streams, setStreams] = useState([]);
  const [media, setMedia] = useState([]);
  const [loop, setLoop] = useState(false);
  const join = async () => {
    const rptCapabilities = await joinRoom();
    setOpt({...opt, rptCapabilities});
  };
  const sync = async () => {
    const peers = await pullItems();
    setOpt({peers});
  };

  useEffect(() => {
    main().then(device => setOpt({...opt, device}));
    return onLeave;
  }, []);

  useEffect(() => {
    let timer = null;

    if (loop) {
      timer = setInterval(() => sync(), 1000);
    }

    return () => {
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [loop]);

  return (
    <ScrollView>
      <Button title={'Join'} onPress={join} />
      <Button
        title={'Sync'}
        onPress={() => {
          sync();
          setLoop(true);
        }}
      />
      <Button
        color={loop ? 'green' : 'red'}
        title={'Toggle sync: ' + (loop ? 'ON' : 'OFF')}
        onPress={() => setLoop(!loop)}
      />
      <Button
        title={'List streams'}
        onPress={() => {
          const streams = getPeerStreams();
          setStreams(streams);
        }}
      />
      {streams.map((stream, index) => (
        <Button
          key={index}
          title={'Connecto to: ' + stream.peerId + ':' + stream.mediaTag}
          onPress={async () => {
            const p = await subscribeToTrack(stream.peerId, stream.mediaTag);
            setMedia([...media, p]);
          }}
        />
      ))}
      <Button
        color={'orange'}
        title={'Send stream'}
        onPress={async () => {
          await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.CAMERA,
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          ]);

          sendCameraStreams();
        }}
      />
      {media.map((m, index) => {
        if (!m || !m.srcObject) {
          return null;
        }

        return (
          <React.Fragment key={index}>
            <RTCView
              streamURL={m.srcObject.toURL()}
              style={{
                width: m.autoplay ? 0 : Dimensions.get('screen').width,
                height: m.autoplay ? 0 : Dimensions.get('screen').width,
              }}
            />
          </React.Fragment>
        );
      })}
      <Text>{JSON.stringify(opt, null, 2)}</Text>
      <Text>{JSON.stringify(opt, null, 2)}</Text>
    </ScrollView>
  );
}

export default App;
