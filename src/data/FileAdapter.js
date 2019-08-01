'use strict';

import fs from 'fs';

import migrate, { getLatestVersionNumber } from 'data/migrate.js';
import Player from 'models/Player.js';
import Game from 'models/Game.js';
import GameSummary from 'models/GameSummary.js';
import ServerError from 'server/Error.js';

const filesDir = 'src/data/files';

export default class {
  createPlayer(playerData) {
    let player = Player.create(playerData);
    player.version = getLatestVersionNumber('player');

    this._writeFile(`player_${player.id}`, player);
    return player;
  }
  savePlayer(player) {
    this._writeFile(`player_${player.id}`, player);
  }
  getPlayer(playerId) {
    let playerData = this._readFile(`player_${playerId}`);
    return Player.load(migrate('player', playerData));
  }

  removePlayerDevice(player, deviceId) {
    player.removeDevice(deviceId);

    this.savePlayer(player);
    this.setPushSubscription(player.id, deviceId, null);
  }

  createGame(stateData) {
    let game = Game.create(stateData);
    game.version = getLatestVersionNumber('game');

    this._writeFile(`game_${game.id}`, game);
    this._saveGameSummary(game);

    return Promise.resolve(game);
  }
  saveGame(game) {
    this._writeFile(`game_${game.id}`, game);
    this._saveGameSummary(game);

    return Promise.resolve(game);
  }
  getGame(gameId) {
    let gameData = this._readFile(`game_${gameId}`);
    return Game.load(migrate('game', gameData));
  }

  setPushSubscription(playerId, deviceId, subscription) {
    let fileName = `player_${playerId}_push`;
    let pushData = this._readFile(fileName, {
      subscriptions: [],
    });
    pushData.subscriptions = new Map(pushData.subscriptions);
    if (subscription)
      pushData.subscriptions.set(deviceId, subscription);
    else
      pushData.subscriptions.delete(deviceId);
    pushData.subscriptions = [...pushData.subscriptions];

    this._writeFile(fileName, pushData);
  }
  getAllPushSubscriptions(playerId) {
    let fileName = `player_${playerId}_push`;
    let pushData = this._readFile(fileName, {
      subscriptions: [],
    });

    return new Map(pushData.subscriptions);
  }

  /*
   * It doesn't matter what the query syntax is, so long as the client and the
   * data adapter can understand it.  As a rule, the server should not be in the
   * business of constructing queries.  If the server needs a filtered data set,
   * then a specialized data adapter method should be created to provide it.
   *
   * With all that said, I'm working with a JSON representation of a query using
   * the following structure that I expect would be intuitive and readable.
   *
   * Query structure:
   *   {
   *     "filters": filter,         // nested list of filters
   *     "page": #pageNumber#,      // base 1
   *     "limit": #ResultsPerPage#, // default 10
   *     "sort": [sort],            // list of sort criteria
   *   }
   *
   * Filter structure:
   *   A filter is either an array or an object.  The brackets and braces are
   *   similar to parenthetical groups of groups or conditions that are joined
   *   using a boolean 'OR' or 'AND' operator respectively.
   *
   *   JSON: { "isEnded":true, "teams.playerId":[123,456] }
   *   SQL : ( isEnded = true AND teams.playerId IN (123,456) )
   *
   *   JSON: [{ "started":null }, { "teams.playerId":[123,456] }]
   *   SQL : (( started IS null ) OR ( teams.playerId IN (123,456)))"
   *
   *   The "NOT" operator can be applied to a group.  These expressions are the
   *   negated versions of the above.  Unlike most object filters, the "!"
   *   property is not treated as a field name and should be the only property.
   *
   *   JSON: { "!": { "isEnded":true, "teams.playerId":[123,456] } }
   *   SQL : NOT ( isEnded = true AND teams.playerId IN (123,456) )
   *
   *   JSON: { "!": [{ "started":null }, { "teams.playerId":[123,456] }] }
   *   SQL : NOT (( started IS null ) OR ( teams.playerId IN (123,456)))"
   *
   *   Besides the implied "=" and "IN" operators demonstrated above, other
   *   condition operators can also be used if the value is an object.
   *   I haven't implemented special condition operators, but here are a few.
   *
   *   JSON: { "nameOfStringField":   { "match":"^regex"               } }
   *   JSON: { "nameOfNumberField:    { "between":[5, 7]               } }
   *   JSON: { "nameOfDateField":     { ">":"2019-07-08T00:00:00.000Z" } }
   *   JSON: { "nameOfOptionalField": { "exists":true                  } }
   *   JSON: { "nameOfArrayField":    { "isDeeply":[1, 2, 3]           } }
   *
   * Sort structure:
   *   Each element in the sort list is either a string or object.  If a string,
   *   then it is the field name.  Nested fields use dot separators.
   *   {
   *     "order": "asc" | "desc",
   *     "field": <field>,
   *   }
   *
   * Return structure:
   *   {
   *     "page": #pageNumber#,
   *     "limit": #ResultsPerPage#,
   *     "count": #TotalResults#,
   *     "results": [...],  // list of game summaries
   *   }
   */
  searchPlayerGames(playerId, query) {
    query = Object.assign({
      page: 1,
      limit: 10,
    }, query);

    if (query.limit > 50)
      throw new ServerError(400, 'Maximum limit is 50');

    let offset = (query.page - 1) * query.limit;
    let games = this._getPlayerGamesSummary(playerId);
    let results = [...games.values()]
      .filter(this._compileFilter(query.filter))
      .sort(this._compileSort(query.sort));

    return Promise.resolve({
      page: query.page,
      limit: query.limit,
      count: games.length,
      results: results.slice(offset, offset+query.limit),
    });
  }

  /*
   * Not intended for use by applications.
   */
  listAllGameIds() {
    return new Promise((resolve, reject) => {
      let gameIds = [];
      let regex = /^game_(.+)\.json$/;

      fs.readdir(filesDir, (err, fileNames) => {
        for (let i=0; i<fileNames.length; i++) {
          let match = regex.exec(fileNames[i]);
          if (!match) continue;

          gameIds.push(match[1]);
        }

        resolve(gameIds);
      });
    });
  }

  /*
   * Get all of the games in which the player is participating.
   */
  _getPlayerGamesSummary(playerId) {
    return new Map(this._readFile(`player_${playerId}_games`, []));
  }
  /*
   * Update the game summary for all participating players.
   */
  _saveGameSummary(game) {
    let summary = new GameSummary(game);

    game.state.teams.forEach(team => {
      let playerId = team && team.playerId;
      if (!playerId) return;

      let summaryList = this._getPlayerGamesSummary(playerId);
      summaryList.set(game.id, summary);

      this._writeFile(`player_${playerId}_games`, [...summaryList]);
    });
  }

  _writeFile(name, data) {
    // Avoid corrupting files when crashing by writing to a temporary file.
    fs.writeFileSync(`${filesDir}/.${name}.json`, JSON.stringify(data));
    fs.renameSync(`${filesDir}/.${name}.json`, `${filesDir}/${name}.json`);
  }
  _readFile(name, initialValue) {
    try {
      let json = fs.readFileSync(`${filesDir}/${name}.json`, 'utf8');
      return JSON.parse(json);
    }
    catch (error) {
      if (error.code === 'ENOENT')
        if (initialValue === undefined)
          error = new ServerError(404, 'Not found');
        else
          return initialValue;

      throw error;
    }
  }

  _compileFilter(filter) {
    if (!filter)
      return item => true;

    return item => this._matchItem(item, filter);
  }
  _matchItem(item, filter) {
    if (Array.isArray(filter))
      // OR logic: return true for the first sub-filter that returns true.
      // Otherwise, return false.
      return !!filter
        .find(f => this._matchItem(item, f));
    else if (filter !== null && typeof filter === 'object') {
      if ('!' in filter)
        return !this._matchItem(item, filter['!']);

      // AND logic: return false for the first sub-filter that returns false.
      // Otherwise, return true.
      return !Object.keys(filter)
        .find(f => !this._matchItemByCondition(item, f, filter[f]));
    }
    else
      throw new Error('Malformed filter');
  }
  _matchItemByCondition(item, field, value) {
    if (field.includes('.'))
      throw new Error('Filtering by nested fields is not implemented');
    if (typeof item[field] === 'object' && typeof value !== 'object')
      throw new Error('Complex conditions are required for complex fields');

    if (Array.isArray(value))
      return value.includes(item[field]);
    else if (value !== null && typeof value === 'object')
      throw new Error('Complex conditions are not implemented');
    else
      return item[field] === value;
  }

  _compileSort(sort) {
    if (!sort)
      return (a, b) => 0;

    if (typeof sort === 'string')
      return (a, b) => this._sortItemsByField(a, b, sort);
    else
      throw new ServerError(501, 'Only a string sort type is supported');
  }
  _sortItemsByField(a, b, str) {
    if (a[str] < b[str]) return -1;
    if (b[str] < a[str]) return 1;
    return 0;
  }
};
