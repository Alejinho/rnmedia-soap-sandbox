import * as mediasoup from 'mediasoup-client';

export const myPeerId = uuidv4();

let log = console.log;
let joined = false;
let device = null;
let currentActiveSpeaker = null;
let consumers = [];
let lastPollSyncData = {};
let recvTransport = null;
let sendTransport = null;
let localCam = null;
let camVideoProducer = null;
let camAudioProducer = null;

const host = `http://192.168.0.10:3000`

const CAM_VIDEO_SIMULCAST_ENCODINGS =
[
  { maxBitrate:  96000, scaleResolutionDownBy: 4 },
  { maxBitrate: 680000, scaleResolutionDownBy: 1 },
];

export async function main() {
  log(`starting up ... my peerId is ${myPeerId}`);
  try {
    device = new mediasoup.Device({handlerName: 'ReactNative'});
    return device;
  } catch (e) {
    if (e.name === 'UnsupportedError') {
      console.error('browser not supported for video calls');
      return;
    } else {
      console.error(e);
    }
  }
}

export function onLeave() {
  sig('leave', {}, true);
}

export async function joinRoom() {
  if (joined) {
    return;
  }

  log('join room');

  // signal that we're a new peer and initialize our
  // mediasoup-client device, if this is our first time connecting
  let {routerRtpCapabilities} = await sig('join-as-new-peer');
  if (!device.loaded) {
    await device.load({routerRtpCapabilities});
  }
  joined = true;
  return routerRtpCapabilities;
}

async function sig(endpoint, data, beacon) {
  try {
    let headers = {'Content-Type': 'application/json'},
      body = JSON.stringify({...data, peerId: myPeerId});

    let response = await fetch(
      `${host}/signaling/${endpoint}`,
      {
        method: 'POST',
        body,
        headers,
      },
    );
    return await response.json();
  } catch (e) {
    console.error(e);
    return {error: e};
  }
}

export async function pullItems() {
  let {peers, activeSpeaker, error} = await sig('sync');
  if (error) {
    return {error};
  }

  // always update bandwidth stats and active speaker display
  currentActiveSpeaker = activeSpeaker;

  // if a peer has gone away, we need to close all consumers we have
  // for that peer and remove video and audio elements
  for (let id in lastPollSyncData) {
    if (!peers[id]) {
      log(`peer ${id} has exited`);
      consumers.forEach(consumer => {
        if (consumer.appData.peerId === id) {
          closeConsumer(consumer);
        }
      });
    }
  }

  // if a peer has stopped sending media that we are consuming, we
  // need to close the consumer and remove video and audio elements
  consumers.forEach(consumer => {
    let {peerId, mediaTag} = consumer.appData;
    if (!peers[peerId].media[mediaTag]) {
      log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
      closeConsumer(consumer);
    }
  });

  lastPollSyncData = peers;
  // return an empty object if there isn't an error
  return {peers};
}

export function getPeerStreams() {
  let sortedPeers = sortPeers(lastPollSyncData);
  let l = [];

  for (let peer of sortedPeers) {
    if (peer.id === myPeerId) {
      continue;
    }
    for (let [mediaTag, info] of Object.entries(peer.media)) {
      l.push({peerId: peer.id, mediaTag, info});
    }
  }

  return l;
}

function sortPeers(peers) {
  return Object.entries(peers)
    .map(([id, info]) => ({id, joinTs: info.joinTs, media: {...info.media}}))
    .sort((a, b) => (a.joinTs > b.joinTs ? 1 : b.joinTs > a.joinTs ? -1 : 0));
}

function uuidv4() {
  return '111-111-1111'.replace(/[018]/g, () => Math.floor(Math.random() * 10));
}

export async function subscribeToTrack(peerId, mediaTag) {
  log('subscribe to track', peerId, mediaTag);

  // create a receive transport if we don't already have one
  if (!recvTransport) {
    recvTransport = await createTransport('recv');
  }

  // if we do already have a consumer, we shouldn't have called this
  // method
  let consumer = findConsumerForTrack(peerId, mediaTag);
  if (consumer) {
    console.warn('already have consumer for track', peerId, mediaTag);
    return;
  }

  // ask the server to create a server-side consumer object and send
  // us back the info we need to create a client-side consumer
  let consumerParameters = await sig('recv-track', {
    mediaTag,
    mediaPeerId: peerId,
    rtpCapabilities: device.rtpCapabilities,
  });
  log('consumer parameters', consumerParameters);
  consumer = await recvTransport.consume({
    ...consumerParameters,
    appData: {peerId, mediaTag},
  });
  log('created new consumer', consumer.id);

  // the server-side consumer will be started in paused state. wait
  // until we're connected, then send a resume request to the server
  // to get our first keyframe and start displaying video
  while (recvTransport.connectionState !== 'connected') {
    log('  transport connstate', recvTransport.connectionState);
    await sleep(100);
  }
  // okay, we're ready. let's ask the peer to send us media
  await resumeConsumer(consumer);

  // keep track of all our consumers
  consumers.push(consumer);

  // ui
  return await addVideoAudio(consumer);
}

function addVideoAudio(consumer) {
  if (!(consumer && consumer.track)) {
    return;
  }
  let el = {};
  // set some attributes on our audio and video elements to make
  // mobile Safari happy. note that for audio to play you need to be
  // capturing from the mic/camera
  if (consumer.kind === 'video') {
    el.playsinline = true;
  } else {
    el.playsinline = true;
    el.autoplay = true;
  }
  el.srcObject = new MediaStream([consumer.track]);
  el.consumer = consumer;
  return el;
}

function findConsumerForTrack(peerId, mediaTag) {
  return consumers.find(
    c => c.appData.peerId === peerId && c.appData.mediaTag === mediaTag,
  );
}

async function createTransport(direction) {
  log(`create ${direction} transport`);

  // ask the server to create a server-side transport object and send
  // us back the info we need to create a client-side transport
  let transport,
    {transportOptions} = await sig('create-transport', {direction});
  log('transport options', transportOptions);

  if (direction === 'recv') {
    transport = await device.createRecvTransport(transportOptions);
  } else if (direction === 'send') {
    transport = await device.createSendTransport(transportOptions);
  } else {
    throw new Error(`bad transport 'direction': ${direction}`);
  }

  // mediasoup-client will emit a connect event when media needs to
  // start flowing for the first time. send dtlsParameters to the
  // server, then call callback() on success or errback() on failure.
  transport.on('connect', async ({dtlsParameters}, callback, errback) => {
    log('transport connect event', direction);
    let {error} = await sig('connect-transport', {
      transportId: transportOptions.id,
      dtlsParameters,
    });
    if (error) {
      err('error connecting transport', direction, error);
      errback();
      return;
    }
    callback();
  });

  if (direction === 'send') {
    // sending transports will emit a produce event when a new track
    // needs to be set up to start sending. the producer's appData is
    // passed as a parameter
    transport.on(
      'produce',
      async ({kind, rtpParameters, appData}, callback, errback) => {
        log('transport produce event', appData.mediaTag);
        // we may want to start out paused (if the checkboxes in the ui
        // aren't checked, for each media type. not very clean code, here
        // but, you know, this isn't a real application.)
        let paused = false;
        // tell the server what it needs to know from us in order to set
        // up a server-side producer object, and get back a
        // producer.id. call callback() on success or errback() on
        // failure.
        let {error, id} = await sig('send-track', {
          transportId: transportOptions.id,
          kind,
          rtpParameters,
          paused,
          appData,
        });
        if (error) {
          err('error setting up server-side producer', error);
          errback();
          return;
        }
        callback({id});
      },
    );
  }

  // for this simple demo, any time a transport transitions to closed,
  // failed, or disconnected, leave the room and reset
  //
  transport.on('connectionstatechange', async state => {
    log(`transport ${transport.id} connectionstatechange ${state}`);
    // for this simple sample code, assume that transports being
    // closed is an error (we never close these transports except when
    // we leave the room)
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      log('transport closed ... leaving the room and resetting');
      leaveRoom();
    }
  });

  return transport;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(() => r(), ms));
}

export async function pauseConsumer(consumer) {
  if (consumer) {
    log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
    try {
      await sig('pause-consumer', {consumerId: consumer.id});
      await consumer.pause();
    } catch (e) {
      console.error(e);
    }
  }
}

export async function resumeConsumer(consumer) {
  if (consumer) {
    log('resume consumer', consumer.appData.peerId, consumer.appData.mediaTag);
    try {
      await sig('resume-consumer', {consumerId: consumer.id});
      await consumer.resume();
    } catch (e) {
      console.error(e);
    }
  }
}

export async function leaveRoom() {
  if (!joined) {
    return;
  }

  log('leave room');

  // close everything on the server-side (transports, producers, consumers)
  let {error} = await sig('leave');
  if (error) {
    err(error);
  }

  // closing the transports closes all producers and consumers. we
  // don't need to do anything beyond closing the transports, except
  // to set all our local variables to their initial states
  try {
    recvTransport && (await recvTransport.close());
    sendTransport && (await sendTransport.close());
  } catch (e) {
    console.error(e);
  }

  recvTransport = null;
  sendTransport = null;
  lastPollSyncData = {};
  consumers = [];
  joined = false;
}

export async function sendCameraStreams() {
  log('send camera streams');

  // make sure we've joined the room and started our camera. these
  // functions don't do anything if they've already been called this
  // session
  await joinRoom();
  await startCamera();

  // create a transport for outgoing media, if we don't already have one
  if (!sendTransport) {
    sendTransport = await createTransport('send');
  }

  // start sending video. the transport logic will initiate a
  // signaling conversation with the server to set up an outbound rtp
  // stream for the camera video track. our createTransport() function
  // includes logic to tell the server to start the stream in a paused
  // state, if the checkbox in our UI is unchecked. so as soon as we
  // have a client-side camVideoProducer object, we need to set it to
  // paused as appropriate, too.
  camVideoProducer = await sendTransport.produce({
    track: localCam.getVideoTracks()[0],
    encodings: camEncodings(),
    appData: {mediaTag: 'cam-video'},
  });

  // same thing for audio, but we can use our already-created
  camAudioProducer = await sendTransport.produce({
    track: localCam.getAudioTracks()[0],
    appData: {mediaTag: 'cam-audio'},
  });
}

export async function startCamera() {
  if (localCam) {
    return;
  }
  log('start camera');
  try {
    localCam = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  } catch (e) {
    console.error('start camera error', e);
  }
}

function camEncodings() {
  return CAM_VIDEO_SIMULCAST_ENCODINGS;
}
