
import { createAction, createThunkAction } from "metabase/lib/redux";

import { normalize, Schema, arrayOf } from 'normalizr';
import i from "icepick";
import _ from "underscore";

import { inflect } from "metabase/lib/formatting";
import MetabaseAnalytics from "metabase/lib/analytics";
import { setRequestState } from "metabase/redux/requests";

import { getVisibleEntities, getSelectedEntities } from "./selectors";
import { addUndo } from "./undo";
import { push } from "react-router-redux";
import { updateIn } from "icepick";

const card = new Schema('cards');
const label = new Schema('labels');
card.define({
  labels: arrayOf(label)
});

import { CardApi } from "metabase/services";

const SELECT_SECTION = 'metabase/questions/SELECT_SECTION';
const SET_SEARCH_TEXT = 'metabase/questions/SET_SEARCH_TEXT';
const SET_ITEM_SELECTED = 'metabase/questions/SET_ITEM_SELECTED';
const SET_ALL_SELECTED = 'metabase/questions/SET_ALL_SELECTED';
const SET_FAVORITED = 'metabase/questions/SET_FAVORITED';
const SET_ARCHIVED = 'metabase/questions/SET_ARCHIVED';
const SET_LABELED = 'metabase/questions/SET_LABELED';
const SET_COLLECTION = 'metabase/collections/SET_COLLECTION';

export const selectSection = createThunkAction(SELECT_SECTION, (query = {}, type = "cards") => {
    return async (dispatch, getState) => {
        if (query.f == null) {
            query = { ...query, f: "all" };
        }

        dispatch(setRequestState({ statePath: ['questions', 'fetch'], state: "LOADING" }));
        let response = await CardApi.list(query);
        dispatch(setRequestState({ statePath: ['questions', 'fetch'], state: "LOADED" }));

        let section = JSON.stringify(query);

        return { type, section, ...normalize(response, arrayOf(card)) };
    }
});

export const search = (q) => push("/questions/search?q=" + encodeURIComponent(q))

export const setFavorited = createThunkAction(SET_FAVORITED, (cardId, favorited) => {
    return async (dispatch, getState) => {
        if (favorited) {
            await CardApi.favorite({ cardId });
        } else {
            await CardApi.unfavorite({ cardId });
        }
        MetabaseAnalytics.trackEvent("Questions", favorited ? "Favorite" : "Unfavorite");
        return { id: cardId, favorite: favorited };
    }
});

function createUndo(type, actions) {
    return {
        type: type,
        count: actions.length,
        message: (undo) => undo.count + " " + inflect(null, undo.count, "question was", "questions were") + " " + type,
        actions: actions
    };
}

export const setArchived = createThunkAction(SET_ARCHIVED, (cardId, archived, undoable = false) => {
    return async (dispatch, getState) => {
        if (cardId == null) {
            // bulk archive
            let selected = getSelectedEntities(getState()).filter(item => item.archived !== archived);
            selected.map(item => dispatch(setArchived(item.id, archived)));
            // TODO: errors
            if (undoable) {
                dispatch(addUndo(createUndo(
                    archived ? "archived" : "unarchived",
                    selected.map(item => setArchived(item.id, !archived))
                )));
                MetabaseAnalytics.trackEvent("Questions", archived ? "Bulk Archive" : "Bulk Unarchive", selected.length);
            }
        } else {
            let card = {
                ...getState().questions.entities.cards[cardId],
                archived: archived
            };
            let response = await CardApi.update(card);
            if (undoable) {
                dispatch(addUndo(createUndo(
                    archived ? "archived" : "unarchived",
                    [setArchived(cardId, !archived)]
                )));
                MetabaseAnalytics.trackEvent("Questions", archived ? "Archive" : "Unarchive");
            }
            return response;
        }
    }
});

export const setLabeled = createThunkAction(SET_LABELED, (cardId, labelId, labeled, undoable = false) => {
    return async (dispatch, getState) => {
        if (cardId == null) {
            // bulk label
            let selected = getSelectedEntities(getState());
            selected.map(item => dispatch(setLabeled(item.id, labelId, labeled)));
            // TODO: errors
            if (undoable) {
                dispatch(addUndo(createUndo(
                    labeled ? "labeled" : "unlabeled",
                    selected.map(item => setLabeled(item.id, labelId, !labeled))
                )));
                MetabaseAnalytics.trackEvent("Questions", labeled ? "Bulk Apply Label" : "Bulk Remove Label", selected.length);
            }
        } else {
            const state = getState();
            const labelSlug = i.getIn(state.questions, ["entities", "labels", labelId, "slug"]);
            const labels = i.getIn(state.questions, ["entities", "cards", cardId, "labels"]);
            const newLabels = labels.filter(id => id !== labelId);
            if (labeled) {
                newLabels.push(labelId);
            }
            if (labels.length !== newLabels.length) {
                await CardApi.updateLabels({ cardId, label_ids: newLabels });
                if (undoable) {
                    dispatch(addUndo(createUndo(
                        labeled ? "labeled" : "unlabeled",
                        [setLabeled(cardId, labelId, !labeled)]
                    )));
                    MetabaseAnalytics.trackEvent("Questions", labeled ? "Apply Label" : "Remove Label");
                }
                return { id: cardId, labels: newLabels, _changedLabelSlug: labelSlug, _changedLabeled: labeled };
            }
        }
    }
});

export const setCollection = createThunkAction(SET_COLLECTION, (cardId, collectionId, undoable = false) => {
    return async (dispatch, getState) => {
        if (cardId == null) {
            // bulk label
            let selected = getSelectedEntities(getState());
            selected.map(item => dispatch(setCollection(item.id, collectionId)));
        } else {
            const collection = _.findWhere(getState().collections.collections, { id: collectionId });
            const card = await CardApi.update({ id: cardId, collection_id: collectionId });
            return {
                ...card,
                _changedSectionSlug: collection && collection.slug
            }
        }
    }
});

export const setSearchText = createAction(SET_SEARCH_TEXT);
export const setItemSelected = createAction(SET_ITEM_SELECTED);

export const setAllSelected = createThunkAction(SET_ALL_SELECTED, (selected) => {
    return async (dispatch, getState) => {
        const visibleEntities = getVisibleEntities(getState());
        let selectedIds = {}
        if (selected) {
            for (let entity of visibleEntities) {
                selectedIds[entity.id] = true;
            }
        }
        MetabaseAnalytics.trackEvent("Questions", selected ? "Select All" : "Unselect All", visibleEntities.length);
        return selectedIds;
    }
});

const initialState = {
    entities: {},
    type: "cards",
    section: null,
    itemsBySection: {},
    searchText: "",
    selectedIds: {},
    undos: []
};

export default function(state = initialState, { type, payload, error }) {
    if (payload && payload.entities) {
        state = i.assoc(state, "entities", i.merge(state.entities, payload.entities));
    }

    switch (type) {
        case SET_SEARCH_TEXT:
            return { ...state, searchText: payload };
        case SET_ITEM_SELECTED:
            return { ...state, selectedIds: { ...state.selectedIds, ...payload } };
        case SET_ALL_SELECTED:
            return { ...state, selectedIds: payload };
        case SELECT_SECTION:
            if (error) {
                return i.assoc(state, "sectionError", payload);
            } else {
                return (i.chain(state)
                    .assoc("type", payload.type)
                    .assoc("section", payload.section)
                    .assoc("sectionError", null)
                    .assoc("selectedIds", {})
                    .assoc("searchText", "")
                    .assocIn(["itemsBySection", payload.type, payload.section, "items"], payload.result)
                    // store the initial sort order so if we remove and undo an item it can be put back in it's original location
                    .assocIn(["itemsBySection", payload.type, payload.section, "sortIndex"], payload.result.reduce((o, id, i) => { o[id] = i; return o; }, {}))
                    .value());
            }
        case SET_FAVORITED:
            if (error) {
                return state;
            } else if (payload && payload.id != null) {
                state = i.assocIn(state, ["entities", "cards", payload.id], {
                    ...state.entities.cards[payload.id],
                    ...payload
                });
                // FIXME: incorrectly adds to sections it may not have previously been in, but not a big deal since we reload whens switching sections
                state = updateSections(state, "cards", payload.id, (s) => s.f === "fav", payload.favorite);
            }
            return state;
        case SET_ARCHIVED:
            if (error) {
                return state;
            } else if (payload && payload.id != null) {
                state = i.assocIn(state, ["entities", "cards", payload.id], {
                    ...state.entities.cards[payload.id],
                    ...payload
                });
                // FIXME: incorrectly adds to sections it may not have previously been in, but not a big deal since we reload whens switching sections
                state = updateSections(state, "cards", payload.id, (s) => s.f === "archived", payload.archived);
                state = updateSections(state, "cards", payload.id, (s) => s.f !== "archived", !payload.archived);
            }
            return state;
        case SET_LABELED:
            if (error) {
                return state;
            } else if (payload && payload.id != null) {
                state = i.assocIn(state, ["entities", "cards", payload.id], {
                    ...state.entities.cards[payload.id],
                    ...payload
                });
                // FIXME: incorrectly adds to sections it may not have previously been in, but not a big deal since we reload whens switching sections
                state = updateSections(state, "cards", payload.id, (s) => s.label === payload._changedLabelSlug, payload._changedLabeled);
            }
            return state;
        case SET_COLLECTION:
            if (error) {
                return state;
            } else if (payload && payload.id != null) {
                state = i.assocIn(state, ["entities", "cards", payload.id], {
                    ...state.entities.cards[payload.id],
                    ...payload
                });
                state = updateSections(state, "cards", payload.id, (s) => s.collection !== payload._changedSectionSlug, false);
                state = updateSections(state, "cards", payload.id, (s) => s.collection === payload._changedSectionSlug, true);
            }
            return state;
        default:
            return state;
    }
}

function updateSections(state, entityType, entityId, sectionPredicate, shouldContain) {
    return updateIn(state, ["itemsBySection", entityType], (sections) =>
        _.mapObject(sections, (section, sectionKey) => {
            if (sectionPredicate(JSON.parse(sectionKey))) {
                const doesContain = _.contains(section.items, entityId);
                if (!doesContain && shouldContain) {
                    return { ...section, items: section.items.concat(entityId) };
                } else if (doesContain && !shouldContain) {
                    return { ...section, items: section.items.filter(id => id !== entityId) };
                }
            }
            return section;
        })
    );
}
