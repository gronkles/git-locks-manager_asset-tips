import React from "react";
import styled from 'styled-components'
import { useSelector, useDispatch } from 'react-redux';
import { Box, themeGet } from '@primer/react';
import { Banner } from '@primer/react/experimental';
import { withTranslation } from "react-i18next";
import { clearSelectedFiles } from 'Redux/components/files/filesSlice';

const MultiFileActionContainer = styled(Box)`
  position: absolute;
  display: flex;
  width: 100%;
  height: 100%;
  pointer-events: none;
  flex-direction: column;
  justify-content: flex-end;
  z-index: 1;

  & > * {
    align-self: center;
  }
`;

const MultiFileActionBanner = styled(Banner)`
  pointer-events: auto;
  margin-bottom: ${themeGet('space.2')};

  & > .BannerContainer {
    flex-direction: column;
  }
`;

function MultiFileAction(props) {
  const dispatch = useDispatch();
  const selectedFiles = useSelector((state) => state.files.selectedFiles);
  const files = useSelector((state) => state.files.list);
  const [busy, setBusy] = React.useState(false);

  const selectedRows = React.useMemo(
    () => selectedFiles.map(p => files.find(f => f.path === p)).filter(Boolean), [selectedFiles, files]
  );

  const { t } = props;

  const allLocked = selectedRows.length > 0 && selectedRows.every(f => !!f.lock);
  const allUnlocked = selectedRows.length > 0 && selectedRows.every(f => !f.lock && !f.isMissing);
  const mixed = selectedRows.length > 0 && !(allLocked || allUnlocked);

  const label = busy
    ? t('Working...')
    : mixed || selectedRows.length === 0
      ? t('Select only Locked or only unlocked')
      : allUnlocked
        ? t('Lock selected')
        : t('Unlock selected');

  const handleClick = () => {
    if (busy || mixed || selectedRows.length === 0) return;
    setBusy(true);
    if (allUnlocked) {
      const batch = selectedRows
        .filter(f => !f.lock && !f.isMissing)
        .map(f => f.rawPath ?? f.path);
      document.dispatchEvent(new CustomEvent('lock-batch', { detail: batch}));
    } else {
      const batch = selectedRows
        .filter(f => f.lock)
        .map(f => f.rawPath ?? f.path);
      document.dispatchEvent(new CustomEvent('unlock-batch', { detail: batch}));
    }
  };

  React.useEffect(() => {
    const done = () => setBusy(false);
    document.addEventListener('lock-batch-done', done);
    document.addEventListener('unlock-batch-done', done);
    return () => {
      document.removeEventListener('lock-batch-done', done);
      document.removeEventListener('unlock-batch-done', done);
    };
  }, []);


  return (
    <MultiFileActionContainer>
      <MultiFileActionBanner
        variant="info"
        title={`${t("Selected files")}: ${selectedRows.length}`}
        primaryAction={(
          <Banner.PrimaryAction
            variant={allUnlocked ? 'outline' : 'danger'}
            disabled={busy || mixed || selectedRows.length === 0}
            onClick={handleClick}
          >
            {label}
          </Banner.PrimaryAction>
        )}
        onDismiss={() => {
          dispatch(clearSelectedFiles());
        }}
      />
    </MultiFileActionContainer>
  );
}

export default withTranslation()(MultiFileAction);