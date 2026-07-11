const EventEmitter = require('events');
const myEmitter = new EventEmitter();

const TREM = require('./constant');

TREM.variable.events = myEmitter;
