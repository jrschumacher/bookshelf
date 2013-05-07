//     Bookshelf.js 0.1.0

//     (c) 2013 Tim Griesser
//     Bookshelf may be freely distributed under the MIT license.
//     For all details and documentation:
//     http://bookshelfjs.org

(function() {

  // Initial Setup
  // -------------
  var Bookshelf = {};

  // Keep a reference to our own copy of Backbone, in case we want to use
  // this specific instance of Backbone elsewhere in the application.
  var Backbone = Bookshelf.Backbone = require('backbone');

  // Local dependency references.
  var _  = require('underscore');
  var Q  = require('q');
  var Knex = require('knex');
  var Inflection = require('inflection');

  // Keep in sync with package.json.
  Bookshelf.VERSION = '0.0.0';

  // We're using `Backbone.Events` rather than `EventEmitter`,
  // for API consistency and portability, but adding some
  // methods to make the API feel a bit more like Node's.
  var Events = Bookshelf.Events = Backbone.Events;
      Events.emit = function() { this.trigger.apply(this, arguments); };
      Events.removeAllListeners = function(event) { this.off(event, null, null); };

  // `Bookshelf` may be used as a top-level pub-sub bus.
  _.extend(Bookshelf, Events);

  // Shared functions which are mixed-in to the
  // `Model`, `Collection`, and `EagerRelation` prototypes.
  var Shared = {

    // Returns an instance of the query builder.
    builder: function(table) {
      return Knex(table);
    },

    // If there are no arguments, return the current object's
    // query builder (or create a new one). If there are arguments,
    // call the query builder with the first argument, applying the
    // rest.
    query: function() {
      this._builder || (this._builder = this.builder(_.result(this, 'tableName')));
      var args = _.toArray(arguments);
      if (args.length === 0) return this._builder;
      this._builder[args[0]].apply(this._builder, args.slice(1));
      return this;
    },

    // Reset the query builder, called internally
    // after a query completes.
    resetQuery: function() {
      delete this._builder;
      return this;
    },

    // Eager loads relationships onto an already populated
    // `Model` or `Collection` instance.
    load: function(relations, options) {
      var target, data;
      if (!_.isArray(relations)) relations = relations ? [relations] : [];
      options = _.extend({}, options, {
        shallow: true,
        withRelated: relations
      });
      if (this instanceof Collection) {
        target = new this.model();
        data = this.toJSON(options);
      } else {
        target = this;
        data = [this.toJSON(options)];
      }
      var model = this;
      return new EagerRelation(this, target, data)
        .processRelated(options)
        .thenResolve(model);
    },

    // Creates and returns a new `Bookshelf.Sync` instance.
    sync: function(model, options) {
      return new Bookshelf.Sync(model, options);
    },

    // Returns the related item
    related: function(item) {
      return this.relations[item];
    }

  };

  // Bookshelf.Model
  // -------------------

  // A Bookshelf Model represents an individual row in the database table --
  // It has a similar implementation to the `Backbone.Model`
  // constructor, except that defaults are not set until the
  // object is persisted, and the collection property is not used.

  // Create a new model with the specified attributes. A client id (`cid`)
  // is automatically generated and assigned for you.
  var Model = Bookshelf.Model = function(attributes, options) {
    var attrs = attributes || {};
    options || (options = {});
    this.cid = _.uniqueId('c');
    this.attributes = {};
    this.relations = {};
    this._configure(options);
    if (options.parse) attrs = this.parse(attrs, options) || {};
    options.protect || (options.protect = false);
    this.set(attrs, options);
    this.changed = {};
    this.initialize.apply(this, arguments);
  };

  // A list of properties that are omitted from the `Backbone.Model.prototype`, since we're not
  // handling validations, or tracking changes in the same way as Backbone, we can drop all of
  // these related features.
  var modelOmitted = ['isValid', 'hasChanged', 'changedAttributes', 'previous', 'previousAttributes'];

  // List of attributes attached directly from the constructor's options object.
  var modelProps = ['tableName', 'hasTimestamps'];

  _.extend(Model.prototype, _.omit(Backbone.Model.prototype, modelOmitted), Events, Shared, {

    // The database table associated with the model.
    tableName: null,

    // Indicates if the model should be timestamped.
    hasTimestamps: false,

    // Ensures the options sent to the model are properly attached.
    _configure: function(options) {
      if (this.options) options = _.extend({}, _.result(this, 'options'), options);
      _.extend(this, _.pick(options, modelProps));
    },

    // The `hasOne` relation specifies that this table has exactly one of
    // another type of object, specified by a foreign key in the other table. The foreign key is assumed
    // to be the singular of this object's `tableName` with an `_id` suffix, but a custom `foreignKey`
    // attribute may also be specified.
    hasOne: function(Target, foreignKey) {
      return this._relatesTo(Target, {
        type: 'hasOne',
        foreignKey: foreignKey || Inflection.singularize(_.result(this, 'tableName')) + '_id'
      });
    },

    // The `hasMany` relation specifies that this object has one or
    // more rows in another table which match on this object's primary key. The foreign key is assumed
    // to be the singular of this object's `tableName` with an `_id` suffix, but a custom `foreignKey`
    // attribute may also be specified.
    hasMany: function(Target, foreignKey) {
      return this._relatesTo(Target, {
        type: 'hasMany',
        foreignKey: foreignKey || Inflection.singularize(_.result(this, 'tableName')) + '_id'
      });
    },

    // A reverse `hasOne` relation, the `belongsTo`, where the specified key in this table
    // matches the primary `idAttribute` of another table.
    belongsTo: function(Target, otherKey) {
      return this._relatesTo(Target, {
        type: 'belongsTo',
        foreignKey: Target.prototype.idAttribute,
        otherKey: otherKey || Inflection.singularize(_.result(Target.prototype, 'tableName')) + '_id'
      });
    },

    // A `belongsToMany` relation is when there are many-to-many relation
    // between two models, with a joining table. The joinTableName may be replaced with another
    // object, will serve as the joining model.
    belongsToMany: function(Target, joinTableName, foreignKey, otherKey) {
      return this._relatesTo(Target, {
        type: 'belongsToMany',
        otherKey: otherKey     || Inflection.singularize(_.result(this, 'tableName')) + '_id',
        foreignKey: foreignKey || Inflection.singularize(_.result(Target.prototype, 'tableName')) + '_id',
        joinTableName: joinTableName || [
          _.result(this, 'tableName'), 
          _.result(Target.prototype, 'tableName')
        ].sort().join('_')
      });
    },

    // Fetch a model based on the currently set attributes,
    // returning a model to the callback, along with any options.
    // Returns a deferred promise through the Bookshelf.sync.
    fetch: function(options) {
      return this.sync(this, options).first();
    },

    // Sets and saves the hash of model attributes,
    // If the server returns an attributes hash that differs,
    // the model's state will be `set` again.
    save: function(key, val, options) {
      var id, attrs;

      // Handle both `"key", value` and `{key: value}` -style arguments.
      if (key == null || typeof key === "object") {
        attrs = key || {};
        options = val || {};
      } else {
        options || (options = {});
        (attrs = {})[key] = val;
      }

      // If the model has timestamp columns,
      // set them as attributes on the model, even
      // if the "partial" option is specified.
      if (this.hasTimestamps) {
        _.extend(attrs, this.timestamp(options));
      }

      // Merge any defaults here rather than during object creation.
      var defaults = _.result(this, 'defaults');
      var vals = attrs;
      if (defaults) {
        vals = _.extend({}, defaults, this.attributes, vals);
      }
      
      // Set the attributes on the model, and maintain a reference to use below.
      var model  = this.set(vals);
      var sync   = model.sync(model, options);
      var method = options.method || (model.isNew(options) ? 'insert' : 'update');

      // Trigger a "beforeSave" event on the model, so we can bind listeners to do any
      // validation, mutating, logging, etc.
      this.trigger('beforeSave', model, method, options);

      return sync[method](attrs, options).then(function(resp) {

        // After a successful database save, the id is updated if the model was created
        model.resetQuery();
        if (resp.insertId) model.set(model.idAttribute, resp.insertId);
        model.trigger((method === 'insert' ? 'create' : 'update'), model, resp, options);

        return model;
      });
    },

    // Destroy a model, calling a delete based on its `idAttribute`.
    destroy: function(options) {
      options || (options = {});
      var model = this;
      this.trigger('beforeDestroy', model, options);
      return this.sync(this, options).del().then(function(resp) {
        model.trigger('destroy', model, resp, options);
        return resp;
      });
    },

    // **format** converts a model into the values that should be saved into
    // the database table. The default implementation is just to pass the response along.
    format: function(attrs, options) {
      return attrs;
    },

    // Returns an object containing a shallow copy of the model attributes,
    // along with the `toJSON` value of any relations,
    // unless `{shallow: true}` is passed in the `options`.
    toJSON: function(options) {
      var attrs = _.extend({}, this.attributes);
      if (options && options.shallow) return attrs;
      var relations = this.relations;
      for (var key in relations) {
        attrs[key] = relations[key];
      }
      return attrs;
    },

    // Sets the timestamps before saving the model.
    timestamp: function(options) {
      var d = new Date();
      var vals = {};
      vals.updated_at = d;
      if (this.isNew(options)) vals.created_at = d;
      return vals;
    },

    // Create a new model with identical attributes to this one,
    // including any appropriate relations for the model.
    clone: function() {
      var model = new this.constructor(this.attributes);
      model.relations = _.map(this.relations, function(relation) {
        return relation.clone();
      });
      return model;
    },

    // Creates a new relation, from the current object to the
    // 'target' object (collection or model), passing a hash of
    // options which can include the `type` of relation.
    // The `hasOne` and `belongsTo` relations may only "target" a `Model`.
    _relatesTo: function(Target, options) {
      var target;
      var type = options.type;
      var multi = (type === 'hasMany' || type === 'belongsToMany');
      if (!multi) {
        if (!Target.prototype instanceof Model) {
          throw new Error('The `'+type+'` related object must be a Bookshelf.Model');
        }
      } else if (Target.prototype instanceof Model) {
        Target = Bookshelf.Collection.extend({
          model: Target,
          builder: Target.prototype.builder
        });
      }

      // If we're handling an eager loaded related model,
      // we need to keep a reference to the original constructor,
      // to assemble the correct object once the eager matching is finished.
      // Otherwise, we need to grab the `foreignKey` value for building the query.
      if (this._isEager) {
        if (multi) {
          options.modelCtor = Target.prototype.model;
          options.collectionCtor = Target;
        } else {
          options.modelCtor = Target;
        }
        options.parentIdAttr = _.result(this, 'idAttribute');
      } else {
        if (type === 'belongsTo') {
          options.fkValue = this.get(options.otherKey);
        } else {
          options.fkValue = this.id;
        }
      }

      // Create a new instance of the `Model` or `Collection`, and set the
      // `_relation` options as a property on the instance.
      target = new Target();
      target._relation = options;

      // Extend the relation with relation-specific methods.
      if (type === 'belongsToMany') {
        _.extend(target, pivotHelpers);
      }
      
      return target;
    },

    // Validation can be complicated, and is better left to be 
    // handled on its own and not mixed in with database logic.
    _validate: function() { 
      return true; 
    }

  });

  // Bookshelf.Collection
  // -------------------

  // A Bookshelf Collection contains a number of database rows, represented by 
  // models, so they can be easily sorted, serialized, and manipulated.
  var Collection = Bookshelf.Collection = function(models, options) {
    if (options) _.extend(this, _.pick(options, collectionProps));
    var model = this.model;
    if (!_.isEqual(model, Model) && !(model.prototype instanceof Model)) {
      throw new Error('Only Bookshelf Model constructors are allowed as the Collection#model attribute.');
    }
    this._reset();
    this.initialize.apply(this, arguments);
    if (models) this.reset(models, _.extend({silent: true}, options));
  };

  // List of attributes attached directly from the constructor's options object.
  var collectionProps = ['model', 'comparator'];

  // Extend the Collection's prototype with the base methods
  _.extend(Collection.prototype, _.omit(Backbone.Collection.prototype, 'model'), Events, Shared, {

    model: Model,

    // Fetch the models for this collection, resetting the models for the query
    // when they arrive.
    fetch: function(options) {
      return this.sync(this, options).select();
    },

    // Shortcut for creating a new model, saving, and adding to the collection.
    // Returns a promise which will resolve with the model added to the collection.
    create: function(model, options) {
      options || (options = {});
      model = this._prepareModel(model, options);
      var collection = this;
      return model.save(null, options).then(function(resp) {
        collection.add(model, options);
        return model;
      });
    },

    // The `tableName` on the associated Model, used in relation building.
    tableName: function() {
      return _.result(this.model.prototype, 'tableName');
    },

    // The `idAttribute` on the associated Model, used in relation building.
    idAttribute: function() {
      return this.model.prototype.idAttribute;
    },

    // Prepare a model or hash of attributes to be added to this collection.
    _prepareModel: function(attrs, options) {
      if (attrs instanceof Model) return attrs;
      return new this.model(attrs, options);
    }

  });

  // Bookshelf.EagerRelation
  // ---------------

  // An `EagerRelation` object temporarily stores the models from an eager load,
  // and handles matching eager loaded objects with their parent(s).
  var EagerRelation = Bookshelf.EagerRelation = function(parent, target, parentResponse) {
    this.parent = parent;
    this.target = target;
    this.parentResponse = parentResponse;
  };

  _.extend(EagerRelation.prototype, Shared, {

    // Fetch the nested related items, and handle the responses.
    // Returns a deferred object, with the cumulative handling of
    // multiple (potentially nested) relations.
    fetch: function(options) {
      
      var current = this;
      var models  = this.models = [];
      var opts    = this._relation;

      Bookshelf.addConstraints(opts.type, this, opts.parentResponse);
      
      return this.query().select(opts.columns).then(function(resp) {

        current.resetQuery();

        // Only find additional related items & process if
        // there is a response from the query.
        if (resp && resp.length > 0) {

          // This can be removed once the dependency of Knex is bumped.
          var filteredResp = skim(resp);

          // We can just push the models onto the collection, rather than resetting.
          for (var i = 0, l = filteredResp.length; i < l; i++) {
            models.push(new opts.modelCtor(filteredResp[i], {parse: true}));
          }

          if (options.withRelated) {
            var model = new opts.modelCtor();
            return new EagerRelation(current, model, resp).processRelated(options);
          }
        }

        return models;
      });
    },

    // This helper function is used internally to determine which relations
    // are necessary for fetching based on the `model.load` or `withRelated` option.
    processRelated: function(options) {
      var name, related, relation;
      var target = this.target;
      var handled = this.handled = {};
      var withRelated = options.withRelated;
      var subRelated = {};
      if (!_.isArray(withRelated)) withRelated = withRelated ? [withRelated] : [];

      // Eager load each of the `withRelated` relation item, splitting on '.'
      // which indicates a nested eager load.
      for (var i = 0, l = options.withRelated.length; i < l; i++) {
        related = options.withRelated[i].split('.');
        name = related[0];

        // Add additional eager items to an array, to load at the next level in the query.
        if (related.length > 1) {
          subRelated[name] || (subRelated[name] = []);
          subRelated[name].push(related.slice(1).join('.'));
        }

        // Only allow one of a certain nested type per-level.
        if (handled[name]) continue;
        
        // Internal flag to determine whether to set the ctor(s) on the _relation hash.
        target._isEager = true;
        relation = target[name]();
        delete target['_isEager'];

        // Set the parent's response, for purposes of setting query constraints.
        relation._relation.parentResponse = this.parentResponse;

        if (!relation) {
          throw new Error(name + ' is not defined on the model.');
        }

        handled[name] = relation;
      }

      // Fetch all eager loaded models.
      var pendingDeferred = [];
      var pendingNames = this.pendingNames = [];
      
      // TODO: look at refactoring the `.call` on the fetch
      // below, it's a bit confusing when debugging.
      for (name in handled) {
        pendingNames.push(name);
        pendingDeferred.push(this.fetch.call(handled[name], {
          transacting: options.transacting,
          withRelated: subRelated[name]
        }));
      }

      // Return a deferred handler for all of the nested object sync
      // returning the original response when these syncs are complete.
      return Q.all(pendingDeferred).spread(_.bind(this.matchResponses, this));
    },

    // Handles the matching against an eager loaded relation.
    matchResponses: function() {
      var args = _.toArray(arguments);
      var parent  = this.parent;
      var handled = this.handled;
      
      // Pair each of the query responses with the parent models.
      for (var i = 0, l = args.length; i < l; i++) {
        
        // Get the current relation this response matches up with, based
        // on the pendingNames array.
        var name = this.pendingNames[i];
        var relation = handled[name];
        var type = relation._relation.type;
        var relatedModels = new RelatedModels(relation.models);

        // If the parent is a collection, we need to loop over each of the
        // models and attach the appropriate sub-models, since they are
        // fetched eagerly. We will re-use the same models for each association level.
        if (parent instanceof Collection) {
          var models = parent.models;
          
          // Attach the appropriate related items onto the parent model.
          // TODO: optimize this section.
          for (var i2 = 0, l2 = models.length; i2 < l2; i2++) {
            var m  = models[i2];
            var id = (type === 'belongsTo' ? m.get(relation._relation.otherKey) : m.id);
            var result = Bookshelf.eagerRelated(type, relation, relatedModels, id);
            m.relations[name] = result;
          }
        } else {
          // If this is a hasOne or belongsTo, we only choose a single item from
          // the relation.
          if (type === 'hasOne' || type === 'belongsTo') {
            parent.relations[name] = relation.models[0] || new relation._relation.modelCtor();
          } else {
            parent.relations[name] = new relation._relation.collectionCtor(relation.models, {parse: true});
          }
        }
      }

      return this.parentResponse;
    }
  });

  // Temporary helper object for handling the response of an `EagerRelation` load.
  var RelatedModels = function(models) {
    this.models = models;
    this.length = this.models.length;
  };
  _.extend(RelatedModels.prototype, _.pick(Collection.prototype, 'find', 'where', 'filter', 'findWhere'));

  // Adds the relation constraints onto the query.
  Bookshelf.addConstraints = function(type, target, resp) {
    if (type !== 'belongsToMany') {
      return constraints(target, resp);
    } else {
      return belongsToMany(target, resp);
    }
  };

  // Handles the "eager related" relationship matching.
  Bookshelf.eagerRelated = function(type, target, eager, id) {
    var relation = target._relation;
    var where = {};
    switch (type) {
      case "hasOne":
      case "belongsTo":
        where[relation.foreignKey] = id;
        // TODO: Should this return an empty model otherwise?
        return eager.findWhere(where);
      case "hasMany":
        where[relation.foreignKey] = id;
        return new relation.collectionCtor(eager.where(where), {parse: true});
      case "belongsToMany":
        where['_pivot_' + relation.otherKey] = id;
        return new relation.collectionCtor(eager.where(where), {parse: true});
    }
  };

  // Standard constraints for regular or eager loaded relations.
  var constraints = function(target, resp) {
    var relation = target._relation;
    if (resp) {
      target.query('whereIn', relation.foreignKey, _.pluck(resp, relation.parentIdAttr));
    } else {
      target.query('where', relation.foreignKey, '=', relation.fkValue);
    }
    return target;
  };

  // Helper function for adding the constraints needed on a eager load.
  var belongsToMany = function(target, resp) {
    var 
    relation      = target._relation,
    columns       = relation.columns || (relation.columns = []),
    builder       = target.query(),
    
    tableName     = _.result(target, 'tableName'),
    idAttribute   = _.result(target, 'idAttribute'),

    otherKey      = relation.otherKey,
    foreignKey    = relation.foreignKey,
    pivotColumns  = relation.pivotColumns,
    joinTableName = relation.joinTableName;

    if (builder.columns.length === 0 && columns.length === 0) {
      columns.push(tableName + '.*');
    }

    columns.push(
      joinTableName + '.' + otherKey + ' as ' + '_pivot_' + otherKey,
      joinTableName + '.' + foreignKey + ' as ' + '_pivot_' + foreignKey
    );
    
    if (pivotColumns) columns.push.apply(columns, pivotColumns);
    
    builder.join(joinTableName, tableName + '.' + idAttribute, '=', joinTableName + '.' + foreignKey);
    
    if (resp) {
      builder.whereIn(joinTableName + '.' + otherKey, _.pluck(resp, idAttribute));
    } else {
      builder.where(joinTableName + '.' + otherKey, '=', relation.fkValue);
    }
    return target;
  };

  // Set up inheritance for the model and collection.
  Model.extend = Collection.extend = EagerRelation.extend = Bookshelf.Backbone.Model.extend;

  // The `forge` function properly instantiates a new Model or Collection
  // without needing the "new" keyword... to make object creation cleaner
  // and more chainable.
  Model.forge = Collection.forge = function() {
    var Ctor = function() {};
    Ctor.prototype = this.prototype;
    var inst = new Ctor();
    var obj = this.apply(inst, arguments);
    return (Object(obj) === obj ? obj : inst);
  };

  // Bookshelf.Sync
  // -------------------

  // Sync is the dispatcher for any database queries,
  // taking the `model` or `collection` being queried, along with
  // a hash of options that are used in the various query methods.
  // If the `transacting` option is set, the query is assumed to be
  // part of a transaction, and this information is passed along to `Knex`.
  var Sync = Bookshelf.Sync = function(model, options) {
    options || (options = {});
    this.model = model;
    this.options = options;
    this.query = model.query();
    var relation = model._relation;
    if (relation && relation.fkValue) {
      Bookshelf.addConstraints(relation.type, model);
    }
    if (options.transacting) this.query.transacting(options.transacting);
  };

  _.extend(Sync.prototype, {

    // Select the first item from the database.
    first: function() {
      this.query.where(_.extend({}, this.model.attributes)).limit(1);
      return this.select();
    },

    // Runs a `select` query on the database, adding any necessary relational
    // constraints, resetting the query when complete. If there are results and
    // eager loaded relations, those are fetched and returned on the model before
    // the promise is resolved. Any `success` handler passed in the
    // options will be called.
    select: function() {
      var model = this.model;
      var options = this.options;
      var columns = options.columns;
      if (!_.isArray(columns)) columns = columns ? [columns] : ['*'];
      return this.query.select(columns).then(function(resp) {
        var target, filteredResp;
        model.resetQuery();
        
        if (resp && resp.length > 0) {
          filteredResp = skim(resp);

          // If this is a model fetch, then we set the parsed attributes
          // on the model, otherwise, we reset the collection.
          if (model instanceof Model) {
            model.set(model.parse(filteredResp[0], options), options);
          } else {
            model.reset(filteredResp, {silent: true, parse: true});
          }
          
          // If the `withRelated` property is specified on the options hash, we dive
          // into the `EagerRelation`. If the current querying object is a collection, 
          // we find the associated `model` to determine necessary eager relations.
          // Once the `EagerRelation` is complete, we return the original response from the query.
          if (options.withRelated) {
            target = (model instanceof Collection ? new model.model() : model);
            return new EagerRelation(model, target, filteredResp)
              .processRelated(options)
              .thenResolve(resp);
          }
          
          return resp;
        }

        // If `{require: true}` is set as an option, the fetch is considered
        // a failure if the model comes up blank.
        if (options.require) return Q.reject('EmptyResponse');

        if (model instanceof Model) {
          model.clear();
          return {};
        }

        model.reset([], {silent: true});
        return [];
        
      }).then(function(resp) {
        if (resp.length > 0) {
          model.trigger('fetched', model, resp, options);
        }
        return model;
      });
    },

    // Issues an `insert` command on the query.
    insert: function() {
      return this.query
        .idAttribute(_.result(this.model, 'idAttribute'))
        .insert(this.model.format(_.extend({}, this.model.attributes)));
    },

    // Issues an `update` command on the query.
    update: function(attrs, options) {
      attrs = (attrs && options.partial ? attrs : this.model.attributes);
      return this.query
        .where(this.model.idAttribute, this.model.id)
        .update(this.model.format(_.extend({}, this.model.attributes)));
    },

    // Issues a `delete` command on the query.
    del: function() {
      var wheres;
      if (this.model.id != null) {
        wheres = {};
        wheres[this.model.idAttribute] = this.model.id;
      }
      if (!wheres && this.query.wheres.length === 0) {
        return Q.reject('A model cannot be destroyed without a "where" clause or an idAttribute.');
      }
      return this.query.where(wheres).del();
    }
  });

  // Helpers
  // -------------------

  // Specific to many-to-many relationships, these methods are mixed
  // into the `belongsToMany` relationships when they are created,
  // providing helpers for attaching and detaching related models.
  var pivotHelpers = {

    _handler: function(method, ids, options) {
      if (ids == void 0 && method === 'insert') return Q.resolve();
      if (!_.isArray(ids)) ids = ids ? [ids] : [];
      var pivot = this._relation;
      var context = this;
      return Q.all(_.map(ids, function(item) {
        var data = {};
        data[pivot.otherKey] = pivot.fkValue;

        // If the item is an object, it's either a model
        // that we're looking to attach to this model, or
        // a hash of attributes to set in the relation.
        if (_.isObject(item)) {
          if (item instanceof Model) {
            data[pivot.foreignKey] = pivot.fkValue;
          } else {
            _.extend(data, item);
          }
        } else if (item) {
          data[pivot.foreignKey] = item;
        }
        var builder = context.builder(pivot.joinTableName);
        if (options && options.transacting) {
          builder.transacting(options.transacting);
        }
        if (method === 'delete') return builder.where(data).del();
        return builder.insert(data);
      }));
    },

    // Attach one or more "ids" from a foreign
    // table to the current. Creates & saves a new model
    // and attaches the model with a join table entry.
    attach: function(ids, options) {
      return this._handler('insert', ids, options);
    },

    // Detach related object from their pivot tables.
    // If a model or id is passed, it attempts to remove the
    // pivot table based on that foreign key. If a hash is passed,
    // it attempts to remove the item based on a where clause with
    // these parameters. If no parameters are specified, we assume we will 
    // detach all related associations.
    detach: function(ids, options) {
      return this._handler('delete', ids, options);
    },

    // Selects any additional columns on the pivot table,
    // taking a hash of columns which specifies the pivot
    // column name, and the value the column should take on the
    // output to the model attributes.
    withPivot: function(columns) {
      if (!_.isArray(columns)) columns = columns ? [columns] : [];
      var joinString, relation = this._relation;
      relation.pivotColumns || (relation.pivotColumns = []);
      for (var i = 0, l = columns.length; i < l; i++) {
        var column = columns[i];
        if (_.isString(column)) {
          relation.pivotColumns.push(relation.joinTableName + '.' + column + ' as pivot_' + column);
        } else {
          for (var key in column) {
            relation.pivotColumns.push(relation.joinTableName + '.' + key + ' as ' + column[key]);
          }
        }
      }
      return this;
    }
  };

  // Filters an array of objects, cleaning out any nested properties.
  var skim = function(data) {
    return _.map(data, function(obj) {
      return _.pick(obj, _.keys(obj));
    });
  };

  // References to the default `Knex` and `Knex.Transaction`, overwritten
  // when a new database connection is created in `Initialize` below.
  Bookshelf.Knex = Knex;
  Bookshelf.Transaction = Knex.Transaction;

  // Bookshelf.Initialize
  // -------------------

  // Configure the `Bookshelf` settings (database adapter, etc.) once,
  // so it is ready on first model initialization.
  Bookshelf.Initialize = function(name, options) {
    var Target;
    if (_.isObject(name)) {
      options = name;
      name = 'default';
    }
    if (Bookshelf.Instances[name]) {
      throw new Error('A ' + name + ' instance of Bookshelf already exists');
    }

    // If an object with this name already exists in `Knex.Instances`, we will
    // use that copy of `Knex` without trying to re-initialize.
    var Builder = (Knex[name] || Knex.Initialize(name, options));

    if (name === 'default') {
      Target = Bookshelf.Instances['default'] = Bookshelf;
    } else {
      Target = Bookshelf.Instances[name] = {};
      
      // Create a new `Bookshelf` instance for this database connection.
      _.extend(Target, _.omit(Bookshelf, 'Instances', 'Initialize', 'Knex', 'Transaction', 'VERSION'), {
        Knex: Builder,
        Transaction: Builder.Transaction
      });

      // Attach a new builder function that references the correct connection.
      _.each(['Model', 'Collection', 'EagerRelation'], function(item) {
        Target[item] = Bookshelf[item].extend({
          builder: function(table) {
            return Builder(table);
          }
        });
      });
    }

    // Set the instanceName, so we know what Bookshelf we're using.
    Target.instanceName = name;

    // Return the initialized instance.
    return Target;
  };

  // Named instances of Bookshelf, presumably with different `Knex`
  // options, to initialize different databases. 
  // The main instance being named "default"...
  Bookshelf.Instances = {};

  // The default Bookshelf `instanceName`... incase we're using Bookshelf
  // after `Knex` has been initialized, for consistency.
  Bookshelf.instanceName = 'default';

  module.exports = Bookshelf;

}).call(this);