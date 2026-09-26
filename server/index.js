require('dotenv').config();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const cors = require('cors');
const { Server } = require('socket.io');
const routes = require('./routes');
const { setupSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use('/api', routes);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

setupSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WebChat lancé sur http://localhost:${PORT}`));
