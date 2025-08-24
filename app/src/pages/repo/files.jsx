import React, { useEffect, useState, useRef } from "react";
import { Box, TextInput, Text, Tooltip, Button, ActionList, ActionMenu, Dialog, themeGet } from "@primer/react";
import { FilteredSearch } from '@primer/react/deprecated'
import styled from 'styled-components';
import { LockIcon, UnlockIcon, AlertIcon, FileIcon, FilterIcon, CheckIcon, PasskeyFillIcon } from '@primer/octicons-react';
import { withTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from 'react-redux';
import { startFetching, stopFetching, setFiles, lockFileLocal, unlockFileLocal, toggleSelectedFile, clearSelectedFiles } from 'Redux/components/files/filesSlice';
import { addError } from 'Redux/components/errors/errorsSlice';
import get from 'lodash/get';
import isEmpty from 'lodash/isEmpty';
import sortBy from 'lodash/sortBy';
import lodashFilter from 'lodash/filter';
import { QuickScore } from 'quick-score';
import latinize from 'latinize';
import moment from 'moment';
import { Scrollbars } from "react-custom-scrollbars-2";
import { AutoSizer } from "react-virtualized";
import { writeConfigRequest } from "secure-electron-store";
import State from 'Components/state/State';
import MultiFileAction from 'Core/multiFileAction';

const Background = styled(Box)`
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: ${themeGet('colors.canvas.subtle')};
`;

const FilterBox = styled(Box)`
  padding: ${themeGet('space.2')};
  display: flex;

  & > *:first-child {
    margin-right: ${themeGet('space.2')};
    width: 100%;
  }
`;

const FilterTextInput = styled(TextInput)`
  width: 100%;
`;

const FilesBox = styled(Box)`
  margin: ${themeGet('space.2')};
  margin-top: 0;

  & > *:not(:last-child) {
    border-bottom: 1px solid ${themeGet('colors.border.default')};
  }
`;

const FileBox = styled(Box)`
  display: flex;
  padding: ${themeGet('space.2')};
  justify-content: space-between;

  background-color: ${({ $selected, theme}) => 
    $selected
      ? (theme?.colors?.accent?.subtle ?? '#ddf4ff')
      : 'transparent'};

  &:hover {
    background-color: ${themeGet('colors.border.default')};
  }
`;

const FileBoxSection = styled(Box)`
  display: flex;

  & > *:first-child {
    margin-right: ${themeGet('space.2')};
  }

  & > * {
    align-self: center;
  }

  &:last-child > span > svg {
    margin-left: ${themeGet('space.2')};
  }

  & mark {
    background-color: unset;
    color: ${themeGet('colors.checks.textLink')};
    font-weight: ${themeGet('fontWeights.bold')};
  }
`;

const Flex = styled(Box)`
  display: flex;
  flex: 1;
`;

const StyledFilteredSearch = styled(FilteredSearch)`
  & > :first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  & svg {
    margin-left: ${themeGet('space.2')};
  }

  & input {
    padding-left: 0;
  }
`;

const SelectionMarker = styled(Box)`
  background-color: var(--color-checks-text-link,#2f81f7);
  width: ${themeGet('space.1')};
  border-radius: ${themeGet('radii.1')};
  position: absolute;
  height: 30px;
  left: 8px;
`;

const StyledForceUnlockIcon = styled(PasskeyFillIcon)`
  align-self: center;
  margin-right: ${themeGet('space.2')};
`;

const FileRow = withTranslation()(function FileRow(props) {
  const [working, setWorking] = useState(false);
  const [errorUnlocking, setErrorUnlocking] = useState(false);
  const dispatch = useDispatch();
  const selectedFiles = useSelector((state) => state.files.selectedFiles);

  const lockFile = (e) => {
    e.stopPropagation();
    if (working) return;
    setWorking(true);
    props.onLock(props.rawPath);
  };

  const unlockFile = (e) => {
    e && e.stopPropagation();
    if (working) return;
    setWorking(true);
    props.onUnlock(props.rawPath)
      .then(() => setErrorUnlocking(false))
      .catch(() => setErrorUnlocking(true))
      .finally(() => setWorking(false));
  };

  useEffect(() => {
    setWorking(false);
  }, [props.lockOwner, props.lastUpdated]);

  useEffect(() => {
    document.addEventListener(`lock-${props.path}`, lockFile);
    document.addEventListener(`unlock-${props.path}`, unlockFile);
    return () => {
      document.removeEventListener(`lock-${props.path}`, lockFile);
      document.removeEventListener(`unlock-${props.path}`, unlockFile);
    };
  }, []);

  const isSelected = selectedFiles.includes(props.path);
  const { t } = props;
  return (
    <FileBox 
      $selected={isSelected}
      aria-selected={isSelected}
      onClick={() => dispatch(toggleSelectedFile(props.path))}
    >
      {isSelected ? <SelectionMarker/> : null}
      <FileBoxSection>
        {props.isMissing ? (
          <Tooltip wrap noDelay direction="e" aria-label={t("This file is not in your branch. Once unlocked this row will disappear.")}>
            <AlertIcon size={16} />
          </Tooltip>
        ) : (
          <FileIcon size={16} />
        )}
        <span>{props.path}</span>
      </FileBoxSection>
      <FileBoxSection>
        {props.lockOwner ? (
          <>
            <Tooltip wrap noDelay direction="w" aria-label={`${t("Locked")} ${moment(props.lockTime).fromNow()}`}>
              {props.lockOwner}
              <LockIcon size={16} />
            </Tooltip>
            {/* removed per-row unlock button */}
          </>
        ) : (
          <>
            <UnlockIcon size={16} />
            {/* removed per-row lock button */}
          </>
        )}
      </FileBoxSection>
    </FileBox>
  )
});

const highlight = (file, path) => {
  if (isEmpty(file.matches[path])) {
    return get(file.item, path);
  }

  const substrings = [];
  let previousEnd = 0;
  const string = get(file.item, path);

  for (let [start, end] of file.matches[path]) {
    const prefix = string.substring(previousEnd, start);
    const match = <mark>{string.substring(start, end)}</mark>;

    substrings.push(prefix, match);
    previousEnd = end;
  }

  substrings.push(string.substring(previousEnd));

  return <span>{React.Children.toArray(substrings)}</span>;
}

const quickScoreOptions = {
  transformString: s => latinize(s).toLowerCase(),
  keys: ["path", "lock.owner.name"],
};

function Files(props) {
  const { repoid } = useParams();
  const [filter, setFilter] = useState('');

  const savedData = window.api.store.initial();

  const [sort, setSort] = useState(savedData['sort'] || 'locked');
  const [hardFilter, setHardFilter] = useState(savedData['hardFilter'] || 'all');
  const repos = useSelector((state) => state.repos.list);
  const files = useSelector((state) => state.files.list);
  const filesLastUpdated = useSelector((state) => state.files.lastUpdated);
  const isRepoSelectorOpen = useSelector((state) => state.repos.selectorOpen);
  const reposLoaded = useSelector((state) => state.repos.initialLoad);
  const selectedFiles = useSelector((state) => state.files.selectedFiles);
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const searchLib = useRef(new QuickScore([], quickScoreOptions));
  const filterField = useRef();
  const isRepoSelectorOpenRef = useRef();

  let repo;
  if (repoid) {
    repo = repos.find(r => r.id === repoid);
  } else {
    repo = undefined;
  }

  const refreshFiles = () => {
    if (!repo) {
      return;
    }

    dispatch(startFetching());
    window.api.git.listLockableFiles(repo.path)
      .then(files => {
        document.dispatchEvent(new CustomEvent(`update-${repoid}`, { detail: files }));
      })
      .catch(err => {
        document.dispatchEvent(new CustomEvent(`error-${repoid}`, { detail: err }));
      });
  };

  const focusFilter = () => {
    if (filterField.current && !isRepoSelectorOpenRef.current) {
      filterField.current.focus();
    }
  };

  const handleFiles = (e) => {
    const { detail: files } = e;
    searchLib.current.setItems(files);
    dispatch(setFiles(files));
  };

  const handleError = ({ detail: err }) => {
    dispatch(addError(err.message || err));
    dispatch(stopFetching());
  };

  useEffect(() => {
    isRepoSelectorOpenRef.current = isRepoSelectorOpen;
  }, [isRepoSelectorOpen]);

  useEffect(() => {
    document.addEventListener(`update-${repoid}`, handleFiles);
    document.addEventListener(`error-${repoid}`, handleError);
    return () => {
      document.removeEventListener(`update-${repoid}`, handleFiles);
      document.removeEventListener(`error-${repoid}`, handleError);
    }
  }, [repoid]);

  useEffect(() => {
    refreshFiles();
  }, [repoid, repos]);

  useEffect(() => {
    document.addEventListener('refreshFiles', refreshFiles);
    document.addEventListener('keydown', focusFilter);
    return () => {
      document.removeEventListener('refreshFiles', refreshFiles);
      document.removeEventListener('keydown', focusFilter);
    };
  }, []);

  if (!repo) {
    if (reposLoaded) {
      navigate('/');
    }
    return null;
  }

  const onLock = (filePath) => {
    //const norm = p => p.replace(/\\/g, '/');
    window.api.git.lockFile(repo.path, filePath)
      .then(() => window.api.git.getLockByPath(repo.path, filePath))
      .then(lock => dispatch(lockFileLocal({ filePath: filePath, lock: lock[0] })))
      .catch(err => dispatch(addError(err.message || String(err))));
  };

  const onUnlock = (filePath, force) => {
    //const norm = p => p.replace(/\\/g, '/');
    return window.api.git.unlockFile(repo.path, filePath, force)
      .then(() => dispatch(unlockFileLocal(filePath)))
      .catch(err => {
        dispatch(addError(err.message || err));
        throw err;
      });
  };

  useEffect(() => {
    const runningRef = { current: false }; // or useRef(false)

    const onLockBatch = (e) => {
      if (runningRef.current) return;
      const filePaths = e.detail || [];
      if (!filePaths.length) return;
      runningRef.current = true;

      window.api.git.lockFiles(repo.path, filePaths)
        .then(({ ok, errors }) => {
          const paths = Object.keys(ok || {});
          if (!paths.length) {
            // keep a consistent shape for the next .then
            return { items: [], errors: errors || [] };
          }
          const lookups = paths.map(fp =>
            window.api.git.getLockByPath(repo.path, fp)
              .then(arr => ({ filePath: fp, lock: arr && arr[0] }))
              .catch(err => ({ filePath: fp, lock: null, error: err }))
          );
          return Promise.all(lookups).then(items => ({ items, errors }));
        })
        .then(({ items, errors }) => {
          items.forEach(({ filePath, lock }) => {
            if (lock) dispatch(lockFileLocal({ filePath, lock }));
          });

          if (errors && errors.length) {
            const msg = errors.length === 1
              ? `Lock failed for ${errors[0].path}: ${errors[0].message}`
              : `Some locks failed:\n` +
                errors.slice(0, 5).map(e => `• ${e.path}: ${e.message}`).join('\n');
            dispatch(addError(msg));
          }
        })
        .catch(err => {
          dispatch(addError(err.message || String(err)));
        })
        .finally(() => {
          dispatch(clearSelectedFiles());
          runningRef.current = false;
          document.dispatchEvent(new CustomEvent('lock-batch-done'));
        });
    };

    const onUnlockBatch = (e) => {
      if (runningRef.current) return;
      const filePaths = e.detail || [];
      if (!filePaths.length) return;
      runningRef.current = true;

      window.api.git.unlockFiles(repo.path, filePaths, false)
        .then(({ ok, errors }) => {
          Object.keys(ok || {}).forEach(fp => dispatch(unlockFileLocal(fp)));

          if (errors && errors.length) {
            const msg = errors.length === 1
              ? `Unlock failed for ${errors[0].path}: ${errors[0].message}`
              : `Some unlocks failed:\n` +
                errors.slice(0, 5).map(e => `• ${e.path}: ${e.message}`).join('\n');
            dispatch(addError(msg));
          }
        })
        .catch(err => {
          dispatch(addError(err.message || String(err)));
        })
        .finally(() => {
          dispatch(clearSelectedFiles());
          runningRef.current = false;
          document.dispatchEvent(new CustomEvent('unlock-batch-done'));
        });
    };

    document.addEventListener('lock-batch', onLockBatch);
    document.addEventListener('unlock-batch', onUnlockBatch);
    return () => {
      document.removeEventListener('lock-batch', onLockBatch);
      document.removeEventListener('unlock-batch', onUnlockBatch);
    };
  }, [repo.path, dispatch]);

  const applyHardFilter = files => {
    if (hardFilter == 'locked') {
      return lodashFilter(files, f => get(f, 'lock.locked_at') || get(f, 'item.lock.locked_at'));
    } else if (hardFilter == 'unlocked') {
      return lodashFilter(files, f => !get(f, 'lock.locked_at') && !get(f, 'item.lock.locked_at'));
    }
    return files;
  }

  let renderedFiles;
  if (filter) {
    const filtered = searchLib.current.search(filter);
    renderedFiles = applyHardFilter(filtered).map(file => (
      <FileRow
        key={file.item.path}
        path={highlight(file, 'path')}
        rawPath={file.item.path}
        lockOwner={highlight(file, 'lock.owner.name')}
        lockTime={get(file.item, 'lock.locked_at')}
        isMissing={file.item.isMissing}
        repo={repo}
        onLock={onLock}
        onUnlock={onUnlock}
        lastUpdated={filesLastUpdated}
      />
    ));
  } else {
    let sortedFiles = sortBy(applyHardFilter(files), 'path');
    if (sort == 'locked') {
      sortedFiles = sortBy(sortedFiles, f => !get(f, 'lock.locked_at'));
    }

    renderedFiles = sortedFiles.map(file => (
      <FileRow
        key={file.path}
        path={file.path}
        rawPath={file.path}
        lockOwner={get(file, 'lock.owner.name')}
        lockTime={get(file, 'lock.locked_at')}
        isMissing={file.isMissing}
        repo={repo}
        onLock={onLock}
        onUnlock={onUnlock}
        lastUpdated={filesLastUpdated}
      />
    ));
  }

  const { t } = props;

  let hardFilterText = t("All Files");
  if (hardFilter == 'locked') {
    hardFilterText = t("Locked Files");
  } else if (hardFilter == 'unlocked') {
    hardFilterText = t("Unlocked Files");
  }

  return (
    <>
      <Background bg="bg.primary">
        <FilterBox>
          <StyledFilteredSearch>
            <ActionMenu>
              <ActionMenu.Button as="summary">{hardFilterText}</ActionMenu.Button>
              <ActionMenu.Overlay>
                <ActionList>
                  <ActionList.Item onClick={() => {
                    setHardFilter('all');
                    window.api.store.send(writeConfigRequest, 'hardFilter', 'all');
                  }}>
                    {t("All Files")} {hardFilter == 'all' ? <CheckIcon /> : null}
                  </ActionList.Item>
                  <ActionList.Item onClick={() => {
                    setHardFilter('locked');
                    window.api.store.send(writeConfigRequest, 'hardFilter', 'locked');
                  }}>
                    {t("Locked Files")} {hardFilter == 'locked' ? <CheckIcon /> : null}
                  </ActionList.Item>
                  <ActionList.Item onClick={() => {
                    setHardFilter('unlocked');
                    window.api.store.send(writeConfigRequest, 'hardFilter', 'unlocked');
                  }}>
                    {t("Unlocked Files")} {hardFilter == 'unlocked' ? <CheckIcon /> : null}
                  </ActionList.Item>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
            <FilterTextInput
              ref={filterField}
              aria-label={t("Filter")}
              name="filter"
              placeholder={t("Filter")}
              icon={FilterIcon}
              onChange={({ target: { value } }) => setFilter(value)}
            />
          </StyledFilteredSearch>
          <ActionMenu>
            <ActionMenu.Button as="summary">{t("Sorting")}</ActionMenu.Button>
            <ActionMenu.Overlay>
              <ActionList>
                <ActionList.Item onClick={() => {
                  setSort('path');
                  window.api.store.send(writeConfigRequest, 'sort', 'path');
                }}>
                  {t("Path")} {sort == 'path' ? <CheckIcon /> : null}
                </ActionList.Item>
                <ActionList.Item onClick={() => {
                  setSort('locked');
                  window.api.store.send(writeConfigRequest, 'sort', 'locked');
                }}>
                  {t("Locked")} {sort == 'locked' ? <CheckIcon /> : null}
                </ActionList.Item>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </FilterBox>
        <Flex>
          {isEmpty(renderedFiles) ? null : (
            <AutoSizer>
              {({ width, height }) => (
                <Scrollbars style={{ width, height }}>
                  <FilesBox>
                    {renderedFiles}
                  </FilesBox>
                </Scrollbars>
              )}
            </AutoSizer>
          )}
        </Flex>
      </Background>
      {selectedFiles.length > 0 ? <MultiFileAction /> : null}
    </>
  );
}

export default withTranslation()(Files);
