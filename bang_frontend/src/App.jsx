import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './styles.css';

const socket = io('http://localhost:3000');

export default function App() {
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState([]);
  const [role, setRole] = useState(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [diceResult, setDiceResult] = useState(null);
  const [currentTurn, setCurrentTurn] = useState(null);
  const [arrowsInPlay, setArrowsInPlay] = useState(0);
  const [indianAttackActive, setIndianAttackActive] = useState(false);

  useEffect(() => {
    socket.on('playerListUpdate', (updatedPlayers) => {
      setPlayers(updatedPlayers);
    });

    socket.on('assignRole', (data) => {
      setRole(data.role);
    });

    socket.on('gameStarted', (players) => {
      setGameStarted(true);
    });

    socket.on('diceResult', (data) => setDiceResult(data));
    socket.on('indianAttack', (isActive) => setIndianAttackActive(isActive));
    socket.on('updateArrows', (arrows) => setArrowsInPlay(arrows));

    return () => {
      socket.off('playerListUpdate');
      socket.off('assignRole');
      socket.off('gameStarted');
      socket.off('diceResult');
      socket.off('indianAttack');
      socket.off('updateArrows');
    };
  }, []);

  const joinGame = () => {
    if (playerName.trim() !== '') {
      socket.emit('joinGame', playerName);
    }
  };

  const startGame = () => {
    socket.emit('startGame');
  };

  const rollDice = () => {
    socket.emit('rollDice');
  };

  return (
    <div className={`app-container ${gameStarted ? 'fullscreen' : ''}`}>
      {!gameStarted ? (
        <div className="lobby-container centered">
          <h1 className="title">🎲 Bang! The Dice Game 🎯</h1>
          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className="input-field"
          />
          <button onClick={joinGame} className="button join-button">
            Join Game
          </button>

          <h2>Players in Lobby:</h2>
          {players.length > 0 ? (
            <ul>
              {players.map((player, index) => (
                <li key={index}>{player.name}</li>
              ))}
            </ul>
          ) : (
            <p>No players in the lobby yet.</p>
          )}

          {players.length >= 4 && (
            <button onClick={startGame} className="button start-button">
              Start Game
            </button>
          )}
        </div>
      ) : (
        <div className="game-container">
          <div className="player-area">
            {players.map((player, index) => (
              <div
                key={index}
                className={`player-card ${currentTurn === player.socketId ? 'active' : ''}`}
              >
                <h4>{player.name}</h4>
                <p>Health: {player.health || 8}</p>
                <p>Role: {player.socketId === socket.id ? role : 'Hidden'}</p>
              </div>
            ))}
          </div>

          <div className="game-info">
            <h2>Your Role: {role}</h2>
            <h3>Your Name: {playerName}</h3>

            {arrowsInPlay > 0 && <p>Arrows in Play: {arrowsInPlay}</p>}
            {indianAttackActive && <p className="indian-attack">⚠️ Indian Attack Active! ⚠️</p>}

            <button onClick={rollDice} className="button roll-button">
              Roll Dice 🎲
            </button>

            {diceResult && (
              <div className="dice-result">
                <p>{diceResult.player} rolled a {diceResult.result}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
