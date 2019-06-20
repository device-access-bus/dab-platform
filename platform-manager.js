/**
    Copyright 2019 Amazon.com, Inc. or its affiliates.
    Copyright 2019 Netflix Inc.
    Copyright 2019 Google LLC

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at
        http://www.apache.org/licenses/LICENSE-2.0
    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

const mqtt = require('mqtt');
const {spawn} = require('child_process');

const client = mqtt.connect('mqtt://localhost');

client.on('connect', () => {
    console.log('we are connected');

    // subscribe to the key-stroke topic
    client.subscribe('platform/input/remote/#')
});

const mappings = {
    "prime-video" : {
        "play": "7",
        "pause" : "7",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "0",
        "RWD": "9"
    },
    "youtube" : {
        "play": "k",
        "pause" : "k",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "l",
        "RWD": "j"
    },
    "netflix" : {
        "play": "Return",
        "pause" : "Return",
        "left" : "Left",
        "right" : "Right",
        "up": "Up",
        "down": "Down",
        "OK": "Return",
        "FWD": "Right",
        "RWD": "Left"
    }
};

function discoverWindowAndPress(app_id, key_code) {
    // find the window
    // send the key code
    let window_id = '';
    let search_process = spawn('xdotool', ['search', '--name', app_id]);

    search_process.stdout.on('data', (chunk) => {
        window_id += chunk.toString();
    });

    search_process.on('exit', () => {
        // send the key stroke
        spawn('xdotool', ['key', '--window', window_id, key_code])
    })
}

function translate(action, app_id) {
    return mappings[app_id][action];
}

client.on('message', (topic, message) => {
    const topicParts = topic.split('/');
    if (topicParts.length !== 5) {
        return;
    }

    const obj = JSON.parse(message.toString());
    const appId = obj["app_id"];
    const action = topicParts[3];

    let keyCode = translate(action, appId);
    if (!keyCode) {
        keyCode = action;
    }

    if (appId === 'prime-video') {
        discoverWindowAndPress('Amazon Prime Video', keyCode)
    } else {
        spawn('xdotool', ['key', keyCode])
    }

    client.publish('_response/' + topic, JSON.stringify({status: 200}))
});